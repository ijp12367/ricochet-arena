# Minimal static web server for Ricochet Arena (browsers block 3D assets on file:// pages).
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8765] [-Open]
param([int]$Port = 8765, [switch]$Open)

$root = [IO.Path]::GetFullPath($PSScriptRoot)
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'
  '.glb' = 'model/gltf-binary'; '.hdr' = 'application/octet-stream'; '.ogg' = 'audio/ogg'
  '.woff2' = 'font/woff2'; '.txt' = 'text/plain; charset=utf-8'
}
# Fallback document shell for an index.html written without one.
$shell = [Text.Encoding]::UTF8.GetBytes("<!doctype html><html lang=""en""><head><meta charset=""utf-8""><meta name=""viewport"" content=""width=device-width, initial-scale=1, viewport-fit=cover""></head><body>`n")

$listener = $null
for ($p = $Port; $p -lt $Port + 20; $p++) {
  try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$p/")
    $listener.Start()
    $Port = $p
    break
  } catch { $listener = $null }
}
if (-not $listener) { Write-Host "Could not open a local port between $Port and $($Port + 19)."; exit 1 }

$url = "http://localhost:$Port/"
Write-Host ""
Write-Host "  RICOCHET ARENA is running at $url"
Write-Host "  Keep this window open while you play. Close it to stop the game server."
Write-Host ""
if ($Open) { Start-Process $url }

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($full)) {
      $res.StatusCode = 404
      $res.Close()
      continue
    }
    $bytes = [IO.File]::ReadAllBytes($full)
    # older copies of index.html had no document shell; add one only when it's missing
    if ($rel -eq 'index.html' -and -not ([Text.Encoding]::UTF8.GetString($bytes, 0, [Math]::Min(64, $bytes.Length)) -match '^\s*<!doctype')) { $bytes = $shell + $bytes }
    $ext = [IO.Path]::GetExtension($full).ToLower()
    $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $res.Headers.Add('Cache-Control', 'no-cache')
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
  } catch {
    # a browser cancelling a request should never stop the server
  }
}
