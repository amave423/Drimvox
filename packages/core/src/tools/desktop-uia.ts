/**
 * The PowerShell side of the desktop tools: Windows UI Automation, the accessibility layer every WinForms, WPF, WinUI,
 * Avalonia and Java (with the Access Bridge) window answers. It reads what to do as JSON from DRIMVOX_UIA and answers
 * JSON on stdout. Elements are found again by their number in the same walk, so a number lives until the window changes.
 */
export const UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = $env:DRIMVOX_UIA | ConvertFrom-Json
$native = 'click', 'type', 'screenshot'
if ($native -contains $p.op) {
  Add-Type -AssemblyName System.Drawing, System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DvxWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
  [void][DvxWin]::SetProcessDPIAware()
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]

function Tops { $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name } }
function Find-Window {
  $w = "$($p.window)"
  if ($w -match '^\d+$') { return $A::FromHandle([IntPtr][long]$w) }
  foreach ($e in Tops) { if ($e.Current.Name.IndexOf($w, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $e } }
  throw "No window with ""$w"" in its title: call app_windows to see them."
}
function Parents {
  $map = @{}
  Get-CimInstance Win32_Process | ForEach-Object { $map[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  $map
}
function Chain($map, [int]$id) {
  $ids = @()
  while ($id -gt 0 -and $ids.Count -lt 30 -and $ids -notcontains $id) { $ids += $id; $id = $map[$id] }
  ,$ids
}
function Info($e) {
  $c = $e.Current
  $v = $null
  $vp = $null
  if ($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $v = $vp.Current.Value }
  $r = $c.BoundingRectangle
  $box = if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { $null } else { @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height) }
  [ordered]@{ type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = $c.Name; id = $c.AutomationId; value = $v; enabled = $c.IsEnabled; box = $box }
}
function Walk($root) {
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $list = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($root, 0))
  while ($stack.Count -gt 0 -and $list.Count -lt 500) {
    $e, $d = $stack.Pop()
    [void]$list.Add(@($e, $d))
    if ($d -ge 15) { continue }
    $kids = @()
    $c = $walker.GetFirstChild($e)
    while ($null -ne $c) { $kids += $c; $c = $walker.GetNextSibling($c) }
    for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($d + 1))) }
  }
  ,$list
}
function Owner($win) {
  $map = Parents
  [ordered]@{ hwnd = $win.Current.NativeWindowHandle; pid = $win.Current.ProcessId; chain = (Chain $map $win.Current.ProcessId) }
}
function Allowed($owner) { $p.any -or @(@($owner.chain) | Where-Object { @($p.allowed) -contains $_ }).Count -gt 0 }
function Element($win) {
  $list = Walk $win
  $n = [int]$p.n
  if ($n -lt 0 -or $n -ge $list.Count) { throw "No element $n in this window: call app_read again." }
  $e = $list[$n][0]
  $i = Info $e
  if ($p.expect -and "$($i.type) $($i.name)" -ne $p.expect) { throw "The window changed since app_read (element $n is now $($i.type) ""$($i.name)""): call app_read again." }
  $e
}
function Front($win) {
  $h = [IntPtr][long]$win.Current.NativeWindowHandle
  if ([DvxWin]::IsIconic($h)) { [void][DvxWin]::ShowWindow($h, 9) }
  [void][DvxWin]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 150
}
function Keys([string]$t) { [Regex]::Replace($t, '[+^%~(){}\[\]]', '{$0}') }

try {
  switch ($p.op) {
    'windows' {
      $map = Parents
      $out = @(Tops | ForEach-Object {
        $c = $_.Current
        $name = try { (Get-Process -Id $c.ProcessId).ProcessName } catch { '' }
        [ordered]@{ hwnd = $c.NativeWindowHandle; pid = $c.ProcessId; process = $name; title = $c.Name; chain = (Chain $map $c.ProcessId) }
      })
      ConvertTo-Json -InputObject @{ windows = $out } -Depth 5 -Compress
    }
    'read' {
      $win = Find-Window
      $list = Walk $win
      $els = @(for ($i = 0; $i -lt $list.Count; $i++) { $x = Info $list[$i][0]; $x.depth = $list[$i][1]; $x })
      ConvertTo-Json -InputObject @{ title = $win.Current.Name; hwnd = $win.Current.NativeWindowHandle; elements = $els; cut = ($list.Count -ge 500) } -Depth 5 -Compress
    }
    'click' {
      $win = Find-Window
      $owner = Owner $win
      if (-not (Allowed $owner)) { ConvertTo-Json -InputObject @{ ask = $true; owner = $owner } -Compress; break }
      $e = Element $win
      $how = $null
      $pat = $null
      if ($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); $how = 'invoked' }
      elseif ($e.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) { $pat.Toggle(); $how = "toggled: $($pat.Current.ToggleState)" }
      elseif ($e.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) { $pat.Select(); $how = 'selected' }
      elseif ($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
        if ($pat.Current.ExpandCollapseState -eq 'Collapsed') { $pat.Expand(); $how = 'expanded' } else { $pat.Collapse(); $how = 'collapsed' }
      } else {
        Front $win
        $r = $e.Current.BoundingRectangle
        if ($r.IsEmpty) { throw 'The element has no place on the screen (hidden or scrolled away).' }
        [void][DvxWin]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
        [DvxWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [DvxWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        $how = 'clicked with the mouse'
      }
      Start-Sleep -Milliseconds 300
      ConvertTo-Json -InputObject @{ done = $how; owner = $owner } -Compress
    }
    'type' {
      $win = Find-Window
      $owner = Owner $win
      if (-not (Allowed $owner)) { ConvertTo-Json -InputObject @{ ask = $true; owner = $owner } -Compress; break }
      $how = @()
      if ($null -ne $p.n) {
        $e = Element $win
        $vp = $null
        if ($null -ne $p.text -and $e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and -not $vp.Current.IsReadOnly) { $vp.SetValue([string]$p.text); $how += 'set the value' }
        elseif ($null -ne $p.text) { Front $win; $e.SetFocus(); [Windows.Forms.SendKeys]::SendWait((Keys ([string]$p.text))); $how += 'typed' }
        else { Front $win; $e.SetFocus() }
        if ($p.keys) { if ($how -contains 'set the value') { Front $win; $e.SetFocus() }; [Windows.Forms.SendKeys]::SendWait([string]$p.keys); $how += "pressed $($p.keys)" }
      } else {
        Front $win
        if ($null -ne $p.text) { [Windows.Forms.SendKeys]::SendWait((Keys ([string]$p.text))); $how += 'typed' }
        if ($p.keys) { [Windows.Forms.SendKeys]::SendWait([string]$p.keys); $how += "pressed $($p.keys)" }
      }
      Start-Sleep -Milliseconds 300
      ConvertTo-Json -InputObject @{ done = ($how -join ', '); owner = $owner } -Compress
    }
    'screenshot' {
      $win = Find-Window
      $h = [IntPtr][long]$win.Current.NativeWindowHandle
      if ([DvxWin]::IsIconic($h)) { [void][DvxWin]::ShowWindow($h, 9); Start-Sleep -Milliseconds 300 }
      $r = New-Object DvxWin+RECT
      [void][DvxWin]::GetWindowRect($h, [ref]$r)
      $bmp = New-Object Drawing.Bitmap ([Math]::Max(1, $r.R - $r.L)), ([Math]::Max(1, $r.B - $r.T))
      $g = [Drawing.Graphics]::FromImage($bmp)
      $dc = $g.GetHdc()
      [void][DvxWin]::PrintWindow($h, $dc, 2)
      $g.ReleaseHdc($dc)
      $g.Dispose()
      $bmp.Save([string]$p.path, [Drawing.Imaging.ImageFormat]::Png)
      ConvertTo-Json -InputObject @{ width = $bmp.Width; height = $bmp.Height; title = $win.Current.Name } -Compress
      $bmp.Dispose()
    }
    'close' {
      $win = Find-Window
      $owner = Owner $win
      if (-not (Allowed $owner)) { ConvertTo-Json -InputObject @{ ask = $true; owner = $owner } -Compress; break }
      $pat = $null
      if (-not $win.TryGetCurrentPattern([Windows.Automation.WindowPattern]::Pattern, [ref]$pat)) { throw 'This window cannot be closed this way.' }
      $title = $win.Current.Name
      $pat.Close()
      ConvertTo-Json -InputObject @{ done = "closed ""$title"""; owner = $owner } -Compress
    }
    default { throw "Unknown op $($p.op)" }
  }
} catch {
  ConvertTo-Json -InputObject @{ error = $_.Exception.Message } -Compress
}
`;
