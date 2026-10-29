// Windows UI Automation view of Chrome's own UI, used to put the focus back.
//
// Why this exists: Chrome 136+ refuses every DevTools transport on the default
// profile (measured: both --remote-debugging-port and Playwright's
// --remote-debugging-pipe), so nothing external can select a tab in the browser
// the user is logged into. UIA is the channel Windows grants to any assistive
// client, and it does reach the browser UI: the tab strip is a ControlType.Tab
// named by ClassName "TabContainerImpl" whose TabItem children expose
// SelectionItemPattern. Measured on this machine, 2026-10-18.
//
// Honest limits of this channel: it sees tab TITLES, not page content, and it
// can only click what Windows can see (select a tab, focus a window). It cannot
// read the DOM, so it is a focus control, not a driving channel — the difference
// between "open the page and hand it back to him" and "drive it", which still
// needs the extension.
//
// Trap found while measuring: a page's own ARIA tabs (class wSkVaW_tab here)
// also come back as TabItem under a window, so a Descendants search for TabItem
// returns web content as if it were browser chrome. Everything here goes
// through the TabContainerImpl first.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pexec = promisify(execFile);

const PS = `
param([string]$Op, [string]$Out, [int]$Hwnd = 0, [int]$Index = -1, [string]$Name = '', [string]$Url = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AbW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
}
'@
Add-Type -TypeDefinition $code

$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]
function Cond($type) { return New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type) }

function ForegroundInfo {
  $h = [AbW]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  $n = [AbW]::GetWindowTextW($h, $sb, 512)
  $title = if ($n -gt 0) { $sb.ToString(0, $n) } else { "" }
  $p = 0
  [void][AbW]::GetWindowThreadProcessId($h, [ref]$p)
  return @{ hwnd = [int]$h; pid = $p; title = $title }
}

function StripOf($win) {
  $best = $null
  foreach ($t in $win.FindAll($TS::Descendants, (Cond $CT::Tab))) {
    if ($t.Current.ClassName -eq 'TabContainerImpl') { $best = $t; break }
  }
  if ($null -eq $best) { return $null }
  $kids = $best.FindAll($TS::Children, (Cond $CT::TabItem))
  $names = @(); $sel = -1
  for ($i = 0; $i -lt $kids.Count; $i++) {
    $k = $kids.Item($i)
    $isSel = $false
    try {
      $pat = $k.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $isSel = [bool]$pat.Current.IsSelected
    } catch {}
    if ($isSel) { $sel = $i }
    $names += $k.Current.Name
  }
  return @{ pid = $win.Current.ProcessId; hwnd = $win.Current.NativeWindowHandle; count = $kids.Count; selected = $sel; titles = $names; items = $kids; container = $best }
}

function WindowByHwnd([int]$want) {
  foreach ($w in $AE::RootElement.FindAll($TS::Children, (Cond $CT::Window))) {
    if ($w.Current.NativeWindowHandle -eq $want) { return $w }
  }
  return $null
}

function TabItemsOf([int]$want) {
  $target = WindowByHwnd $want
  if ($null -eq $target) { return @{ err = "no window hwnd=$want"; items = $null; win = $null } }
  $strip = $null
  foreach ($t in $target.FindAll($TS::Descendants, (Cond $CT::Tab))) {
    if ($t.Current.ClassName -eq 'TabContainerImpl') { $strip = $t; break }
  }
  if ($null -eq $strip) { return @{ err = 'no TabContainerImpl in target window'; items = $null; win = $target } }
  return @{ err = $null; items = $strip.FindAll($TS::Children, (Cond $CT::TabItem)); win = $target }
}

function JsonSafe($s) {
  $strip = StripOf $s
  return @{ pid = $strip.pid; hwnd = $strip.hwnd; count = $strip.count; selected = $strip.selected; titles = $strip.titles }
}

function ChromeWindows {
  $chromePids = @((Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }))
  $out = @()
  foreach ($w in $AE::RootElement.FindAll($TS::Children, (Cond $CT::Window))) {
    if ($chromePids -notcontains $w.Current.ProcessId) { continue }
    $s = StripOf $w
    if ($null -eq $s) { continue }
    $out += (JsonSafe $w)
  }
  return $out
}

$fg = ForegroundInfo
if ($Op -eq 'list') {
  $payload = @{ ok = $true; op = 'list'; foreground = $fg; windows = @(ChromeWindows) }
}
elseif ($Op -eq 'select') {
  $look = TabItemsOf $Hwnd
  if ($look.err) { $payload = @{ ok = $false; error = $look.err } }
  else {
    $kids = $look.items
    if ($Index -lt 0 -or $Index -ge $kids.Count) {
      $payload = @{ ok = $false; error = "index $Index out of range (tabs=$($kids.Count))" }
    } else {
      $pat = $kids.Item($Index).GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $pat.Select()
      $after = JsonSafe $look.win
      $payload = @{ ok = $true; op = 'select'; before = $kids.Count; selectedAfter = $after.selected; titleAfter = $after.titles[$after.selected] }
    }
  }
}
elseif ($Op -eq 'close') {
  $look = TabItemsOf $Hwnd
  if ($look.err) { $payload = @{ ok = $false; error = $look.err } }
  else {
    $kids = $look.items
    if ($Index -lt 0 -or $Index -ge $kids.Count) {
      $payload = @{ ok = $false; error = "index $Index out of range (tabs=$($kids.Count))" }
    } else {
      $tab = $kids.Item($Index)
      $closedTitle = $tab.Current.Name
      $btn = $null
      foreach ($b in $tab.FindAll($TS::Descendants, (Cond $CT::Button))) {
        if ($b.Current.ClassName -eq 'TabCloseButton') { $btn = $b; break }
      }
      if ($null -eq $btn) {
        foreach ($b in $tab.FindAll($TS::Descendants, (Cond $CT::Button))) {
          if ($b.Current.Name -match '关闭|Close') { $btn = $b; break }
        }
      }
      if ($null -eq $btn) { $payload = @{ ok = $false; error = 'no close button on that tab' } }
      else {
        $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Start-Sleep -Milliseconds 400
        $after = JsonSafe $look.win
        $payload = @{ ok = $true; op = 'close'; closedTitle = $closedTitle; countAfter = $after.count; selectedAfter = $after.selected }
      }
    }
  }
}
elseif ($Op -eq 'focus') {
  $h = [IntPtr]$Hwnd
  $startFg = $fg
  $rung = $null
  $attempted = @()
  function FgIs($hh) { return ([AbW]::GetForegroundWindow() -eq $hh) }
  function Restore($hh) { [void][AbW]::ShowWindowAsync($hh, 9); [void][AbW]::ShowWindowAsync($hh, 1) }
  if (FgIs $h) {
    if ([AbW]::IsIconic($h)) { Restore $h }
    $rung = 'already'
  }
  if (-not $rung) {
    if ([AbW]::IsIconic($h)) { Restore $h; Start-Sleep -Milliseconds 250 }
    [void][AbW]::SetForegroundWindow($h)
    $attempted += 'SetForegroundWindow'
    if (FgIs $h) { $rung = 'plain' }
  }
  if (-not $rung) {
    $fgH = [AbW]::GetForegroundWindow()
    $fgPid = 0
    $fgThread = [AbW]::GetWindowThreadProcessId($fgH, [ref]$fgPid)
    $me = [AbW]::GetCurrentThreadId()
    [void][AbW]::AttachThreadInput($me, $fgThread, $true)
    [void][AbW]::BringWindowToTop($h)
    [void][AbW]::SetForegroundWindow($h)
    [void][AbW]::AttachThreadInput($me, $fgThread, $false)
    $attempted += 'AttachThreadInput+BringWindowToTop'
    if (FgIs $h) { $rung = 'attach' }
  }
  if (-not $rung) {
    [AbW]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [AbW]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [void][AbW]::SetForegroundWindow($h)
    $attempted += 'keybd_event(ALT)'
    if (FgIs $h) { $rung = 'alt' }
  }
  if ([AbW]::IsIconic($h)) { [void][AbW]::ShowWindowAsync($h, 9) }
  $payload = @{
    ok = [bool]$rung; op = 'focus'; hwnd = $Hwnd; rung = $rung; attempted = $attempted
    foregroundBefore = $startFg; foregroundAfter = (ForegroundInfo)
  }
}
elseif ($Op -eq 'invoke') {
  $target = WindowByHwnd $Hwnd
  if ($null -eq $target) { $payload = @{ ok = $false; error = "no window hwnd=$Hwnd" } }
  else {
    $seen = @()
    $hit = $null
    $all = $target.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $limit = [Math]::Min($all.Count, 4000)
    for ($i = 0; $i -lt $limit; $i++) {
      $e = $all.Item($i)
      $n = $e.Current.Name
      if ([string]::IsNullOrWhiteSpace($n)) { continue }
      if ($n -notlike "*$Name*") { continue }
      $ct = $e.Current.ControlType.ProgrammaticName
      $can = $null
      try { $can = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch {}
      $seen += "$ct|$n|invokable=$([bool]$can)"
      if ($can -and -not $hit) { $hit = $e }
    }
    if ($hit) {
      try {
        $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $payload = @{ ok = $true; op = 'invoke'; name = $hit.Current.Name; control = $hit.Current.ControlType.ProgrammaticName; seen = $seen }
      } catch {
        $payload = @{ ok = $false; error = ("invoke threw: " + $_.Exception.Message); seen = $seen }
      }
    } else {
      $payload = @{ ok = $false; error = "no invokable control matching '$Name'"; seen = $seen }
    }
  }
}
elseif ($Op -eq 'navigate') {
  $target = WindowByHwnd $Hwnd
  if ($null -eq $target) { $payload = @{ ok = $false; error = "no window hwnd=$Hwnd" } }
  else {
    $box = $null
    foreach ($e in $target.FindAll($TS::Descendants, (Cond $CT::Edit))) {
      if ($e.Current.ClassName -eq 'OmniboxViewViews') { $box = $e; break }
    }
    if ($null -eq $box) { $payload = @{ ok = $false; error = 'no OmniboxViewViews in that window' } }
    else {
      [void][AbW]::ShowWindowAsync([IntPtr]$Hwnd, 9)
      [void][AbW]::SetForegroundWindow([IntPtr]$Hwnd)
      Start-Sleep -Milliseconds 150
      [void]$box.SetFocus()
      Start-Sleep -Milliseconds 120
      try { $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Url) ; $method = 'valuePattern' }
      catch {
        # SendKeys: escape the characters that mean something to it.
        $esc = $Url -replace '([+^%~(){}\[\]])', '{$1}'
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        [System.Windows.Forms.SendKeys]::SendWait($esc)
        $method = 'sendKeys'
      }
      Start-Sleep -Milliseconds 150
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      $payload = @{ ok = $true; op = 'navigate'; method = $method; url = $Url; foreground = (ForegroundInfo) }
    }
  }
}
else {
  $payload = @{ ok = $false; error = "unknown op $Op" }
}
$payload | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $Out -Encoding utf8
exit 0
`;

let psFile = null;
function ensureScript() {
  const target = path.join(os.tmpdir(), "ab-win-tabs.ps1");
  const body = PS.replace(/\r?\n/g, "\r\n");
  if (!psFile || !fs.existsSync(target) || fs.readFileSync(target, "utf8") !== body) {
    fs.writeFileSync(target, body);
  }
  psFile = target;
  return psFile;
}

let outSeq = 0;
async function call(op, { hwnd = 0, index = -1, name = "", url = "", timeoutMs = 60000 } = {}) {
  const out = path.join(os.tmpdir(), `ab-win-tabs-${process.pid}-${++outSeq}.json`);
  if (fs.existsSync(out)) fs.rmSync(out);
  const file = ensureScript();
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "-Op", op, "-Out", out];
  if (hwnd) args.push("-Hwnd", String(hwnd));
  if (index >= 0) args.push("-Index", String(index));
  if (name) args.push("-Name", String(name));
  if (url) args.push("-Url", String(url));
  let stderr = "";
  try {
    const r = await pexec("powershell", args, { timeout: timeoutMs, windowsHide: true });
    stderr = String(r.stderr || "");
  } catch (e) {
    return { ok: false, error: `powershell ${op} failed: ${String(e.message || e).split("\n")[0]}`.slice(0, 300) };
  }
  if (!fs.existsSync(out)) {
    return { ok: false, error: `powershell ${op} produced no output${stderr ? ": " + stderr.slice(0, 160) : ""}` };
  }
  const raw = fs.readFileSync(out, "utf8");
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim();
  fs.rmSync(out, { force: true });
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `powershell ${op} returned non-json: ${text.slice(0, 160)}` };
  }
}

// [{pid,hwnd,count,selected,titles[]}] plus which window/app had focus.
export async function listChromeTabstrips() {
  const r = await call("list");
  if (!r.ok) return { ok: false, error: r.error, windows: [], foreground: null };
  return { ok: true, windows: r.windows || [], foreground: r.foreground || null };
}

export async function selectChromeTab(hwnd, index) {
  return call("select", { hwnd, index });
}

// Only ever call this on a tab we opened ourselves.
export async function closeChromeTab(hwnd, index) {
  return call("close", { hwnd, index });
}

export async function focusWindow(hwnd) {
  return call("focus", { hwnd });
}

// Clicks a control of Chrome's own UI by its accessible name — no coordinates,
// so it does not depend on window size or scroll position. Returns the matches
// it saw, so a miss says what was actually there.
export async function invokeNamed(hwnd, name) {
  return call("invoke", { hwnd, name, timeoutMs: 120000 });
}

// Types a URL into the window's address bar. This is the only route to
// chrome:// pages from outside: passing one to chrome.exe opens a blank tab
// (measured) because Chrome refuses privileged URLs from the command line.
export async function navigateWindow(hwnd, url) {
  return call("navigate", { hwnd, url, timeoutMs: 120000 });
}
