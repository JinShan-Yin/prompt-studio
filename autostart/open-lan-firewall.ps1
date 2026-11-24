param([switch]$Uninstall)
# NewRock AI Workbench - allow inbound TCP 3100 on the private network profile.
$ErrorActionPreference = 'Stop'
$ruleName = 'NewRock AI Workbench (TCP 3100)'
$port = 3100
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Please run this script as Administrator.' -ForegroundColor Yellow
  exit 1
}
if ($Uninstall) {
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Write-Host "Removed inbound rule: $ruleName"
  exit 0
}
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $existing) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private | Out-Null
  Write-Host "Allowed inbound TCP $port (Private profile)."
} else {
  Write-Host "Rule already exists: $ruleName"
}
exit 0
