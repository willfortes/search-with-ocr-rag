package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type downloadReq struct {
	URLs        []string `json:"urls"`
	OutDir      string   `json:"outDir"`
	Concurrency int      `json:"concurrency"`
	MinBytes    int      `json:"minBytes"`
	StartIndex  int      `json:"startIndex"`
	TimeoutMs   int      `json:"timeoutMs"`
}

type itemEvent struct {
	OK     bool   `json:"ok"`
	URL    string `json:"url"`
	Path   string `json:"path,omitempty"`
	File   string `json:"file,omitempty"`
	Bytes  int    `json:"bytes,omitempty"`
	Index  int    `json:"index,omitempty"`
	Error  string `json:"error,omitempty"`
	Ext    string `json:"ext,omitempty"`
}

type doneEvent struct {
	OK      bool `json:"ok"`
	Saved   int  `json:"saved"`
	Failed  int  `json:"failed"`
	Elapsed int  `json:"elapsedMs"`
}

func main() {
	port := envOr("PORT", "3850")
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"go-image-worker"}`))
	})
	mux.HandleFunc("/v1/download", handleDownload)

	addr := ":" + port
	log.Printf("[go-worker] listening on %s (parallel image downloads)", addr)
	if err := http.ListenAndServe(addr, withCORS(mux)); err != nil {
		log.Fatal(err)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req downloadReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if len(req.URLs) == 0 || strings.TrimSpace(req.OutDir) == "" {
		http.Error(w, "urls and outDir required", http.StatusBadRequest)
		return
	}
	if req.Concurrency <= 0 {
		req.Concurrency = 8
	}
	if req.Concurrency > 16 {
		req.Concurrency = 16
	}
	if req.MinBytes <= 0 {
		req.MinBytes = 2048
	}
	if req.StartIndex <= 0 {
		req.StartIndex = 1
	}
	if req.TimeoutMs <= 0 {
		req.TimeoutMs = 25000
	}
	if len(req.URLs) > 40 {
		req.URLs = req.URLs[:40]
	}

	if err := os.MkdirAll(req.OutDir, 0o755); err != nil {
		http.Error(w, "cannot create outDir", http.StatusInternalServerError)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	started := time.Now()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	type job struct {
		url string
		idx int
	}
	jobs := make(chan job, len(req.URLs))
	for i, u := range req.URLs {
		jobs <- job{url: u, idx: req.StartIndex + i}
	}
	close(jobs)

	var saved atomic.Int32
	var failed atomic.Int32
	var mu sync.Mutex
	var wg sync.WaitGroup

	writeEvent := func(event string, payload any) {
		mu.Lock()
		defer mu.Unlock()
		b, _ := json.Marshal(payload)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		flusher.Flush()
	}

	client := &http.Client{
		Timeout: time.Duration(req.TimeoutMs) * time.Millisecond,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}

	worker := func() {
		defer wg.Done()
		for j := range jobs {
			if ctx.Err() != nil {
				return
			}
			res := downloadOne(ctx, client, j.url, req.OutDir, j.idx, req.MinBytes)
			if res.OK {
				saved.Add(1)
			} else {
				failed.Add(1)
			}
			writeEvent("item", res)
		}
	}

	n := req.Concurrency
	if n > len(req.URLs) {
		n = len(req.URLs)
	}
	wg.Add(n)
	for i := 0; i < n; i++ {
		go worker()
	}
	wg.Wait()

	writeEvent("done", doneEvent{
		OK:      true,
		Saved:   int(saved.Load()),
		Failed:  int(failed.Load()),
		Elapsed: int(time.Since(started).Milliseconds()),
	})
}

func downloadOne(ctx context.Context, client *http.Client, rawURL, outDir string, index, minBytes int) itemEvent {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return itemEvent{OK: false, URL: rawURL, Error: err.Error()}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
	req.Header.Set("Referer", "https://www.bing.com/")

	resp, err := client.Do(req)
	if err != nil {
		return itemEvent{OK: false, URL: rawURL, Error: err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return itemEvent{OK: false, URL: rawURL, Error: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}

	ct := resp.Header.Get("Content-Type")
	if ct != "" && !strings.HasPrefix(ct, "image/") && !strings.Contains(ct, "octet-stream") {
		return itemEvent{OK: false, URL: rawURL, Error: "not an image: " + ct}
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, 25<<20)) // 25MB cap
	if err != nil {
		return itemEvent{OK: false, URL: rawURL, Error: err.Error()}
	}
	if len(data) < minBytes {
		return itemEvent{OK: false, URL: rawURL, Error: "file too small"}
	}

	ext := guessExt(rawURL, ct)
	fileName := fmt.Sprintf("%02d_%dx%d%s", index, 0, 0, ext)
	// placeholder dims in name updated after — keep simple unique name
	fileName = fmt.Sprintf("%02d_%d%s", index, len(data), ext)
	dest := filepath.Join(outDir, fileName)
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return itemEvent{OK: false, URL: rawURL, Error: err.Error()}
	}

	return itemEvent{
		OK:    true,
		URL:   rawURL,
		Path:  dest,
		File:  fileName,
		Bytes: len(data),
		Index: index,
		Ext:   strings.TrimPrefix(ext, "."),
	}
}

func guessExt(url, contentType string) string {
	ct := strings.ToLower(contentType)
	switch {
	case strings.Contains(ct, "png"):
		return ".png"
	case strings.Contains(ct, "webp"):
		return ".webp"
	case strings.Contains(ct, "gif"):
		return ".gif"
	case strings.Contains(ct, "jpeg"), strings.Contains(ct, "jpg"):
		return ".jpg"
	}
	lower := strings.ToLower(url)
	for _, e := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif"} {
		if strings.Contains(lower, e) {
			if e == ".jpeg" {
				return ".jpg"
			}
			return e
		}
	}
	return ".jpg"
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
