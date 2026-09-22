# Start Go parallel download worker (port 3850)
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
$env:PORT = '3850'
Set-Location $PSScriptRoot
Write-Host "Starting Go image worker on :3850 ..."
go run .
