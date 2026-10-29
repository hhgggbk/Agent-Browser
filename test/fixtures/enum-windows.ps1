Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public class W {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lp, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 128;
  const int WS_EX_APPWINDOW = 262144;
  public static List<string> List(uint wantPid) {
    var outp = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (wantPid != 0 && pid != wantPid) return true;
      int ex = GetWindowLong(h, GWL_EXSTYLE);
      bool tool = (ex & WS_EX_TOOLWINDOW) != 0;
      bool app = (ex & WS_EX_APPWINDOW) != 0;
      if (tool && !app) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      outp.Add(pid + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
"@
$port = $args[0]
if ($port -eq $null -or $port -eq "") { $port = "0" }
[W]::List([uint32]$port) | ForEach-Object { $_ }
