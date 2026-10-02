// Intentional interactive fixture used to prove actual Windows input reception.
// Run in the same logged-in session as the agent: --output <results.json>.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LocalRemote.Windows {
    internal sealed class ReceiverWindow : Form {
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out NativePoint point);
        [DllImport("user32.dll")] private static extern bool GetClipCursor(out NativeRect rect);
        [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadID);
        [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", ExactSpelling = true, SetLastError = true)] private static extern bool GetUserObjectInformationRaw(IntPtr handle, int index, IntPtr value, int length, out int needed);
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processID);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
        [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
        private readonly string output;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly TextBox editor = new TextBox();
        private readonly Button clickButton = new Button();
        private readonly Panel dragPanel = new Panel();
        private readonly Label summary = new Label();
        private readonly List<object> keys = new List<object>();
        private readonly List<object> mouse = new List<object>();
        private readonly Timer timer = new Timer();
        private int clicks, rightClicks, middleClicks, wheelEvents, wheelDelta, dragMoves, mouseUps, mouseDowns;
        private bool dragging;
        private Point dragStart, dragEnd;
        private string failure;
        private bool activationAccepted;
        private static string ObjectName(IntPtr handle) { StringBuilder name = new StringBuilder(256); int needed; return GetUserObjectInformation(handle, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "unavailable"; }
        private static int? ObjectValue(IntPtr handle, int index, int size, int offset) {
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try { Marshal.Copy(new byte[size], 0, buffer, size); int needed; return GetUserObjectInformationRaw(handle, index, buffer, size, out needed) ? (int?)Marshal.ReadInt32(buffer, offset) : null; }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        private static object InputEnvironment() {
            IntPtr thread = GetThreadDesktop(GetCurrentThreadId()), station = GetProcessWindowStation();
            int? threadIO = ObjectValue(thread, 6, 4, 0), flags = ObjectValue(station, 1, 12, 8);
            IntPtr input = OpenInputDesktop(0, false, 1); int error = input == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            string inputName = "unavailable"; int? inputIO = null;
            try { if (input != IntPtr.Zero) { inputName = ObjectName(input); inputIO = ObjectValue(input, 6, 4, 0); } }
            finally { if (input != IntPtr.Zero) CloseDesktop(input); }
            return new { threadDesktop = ObjectName(thread), threadReceivesInput = threadIO.HasValue ? (object)(threadIO.Value != 0) : null,
                inputDesktop = inputName, inputReceivesInput = inputIO.HasValue ? (object)(inputIO.Value != 0) : null, inputOpenError = error,
                station = ObjectName(station), stationFlags = flags, stationVisible = flags.HasValue ? (object)((flags.Value & 1) != 0) : null };
        }
        private static object BoundsOf(Control control) { Rectangle rect = control.RectangleToScreen(control.ClientRectangle); return new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height, centerX = rect.X + rect.Width / 2, centerY = rect.Y + rect.Height / 2 }; }
        internal ReceiverWindow(string path) {
            output = Path.GetFullPath(path);
            Text = "Local Remote Windows Receiver Test"; ClientSize = new Size(760, 520);
            StartPosition = FormStartPosition.CenterScreen; TopMost = true; BackColor = Color.FromArgb(26, 34, 45); ForeColor = Color.White;
            Font = new Font("Segoe UI", 11); KeyPreview = true;
            Label title = new Label { Text = "Windows native input receiver — validation fixture", AutoSize = true, Location = new Point(24, 20) };
            Controls.Add(title);
            editor.Multiline = true; editor.AcceptsReturn = true; editor.AcceptsTab = true; editor.ScrollBars = ScrollBars.Both;
            editor.SetBounds(24, 58, 712, 240); editor.Font = new Font("Segoe UI", 14); Controls.Add(editor);
            clickButton.Text = "Click / right click / middle click"; clickButton.SetBounds(24, 316, 325, 55); Controls.Add(clickButton);
            clickButton.Click += delegate { clicks++; };
            clickButton.MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Right) rightClicks++; if (e.Button == MouseButtons.Middle) middleClicks++; LogMouse("button_down", e); };
            clickButton.MouseUp += delegate(object sender, MouseEventArgs e) { LogMouse("button_up", e); };
            dragPanel.SetBounds(373, 316, 363, 108); dragPanel.BackColor = Color.FromArgb(43, 85, 128); Controls.Add(dragPanel);
            Label dragLabel = new Label { Text = "Drag here • scroll here", AutoSize = true, Location = new Point(15, 12), Enabled = false }; dragPanel.Controls.Add(dragLabel);
            dragPanel.MouseDown += delegate(object sender, MouseEventArgs e) { dragging = true; dragStart = e.Location; dragEnd = e.Location; mouseDowns++; dragPanel.Capture = true; dragPanel.Focus(); LogMouse("drag_down", e); };
            dragPanel.MouseMove += delegate(object sender, MouseEventArgs e) { if (dragging) { dragMoves++; dragEnd = e.Location; LogMouse("drag_move", e); } };
            dragPanel.MouseUp += delegate(object sender, MouseEventArgs e) { dragging = false; dragEnd = e.Location; mouseUps++; dragPanel.Capture = false; LogMouse("drag_up", e); };
            dragPanel.MouseWheel += WheelReceived; editor.MouseWheel += WheelReceived; MouseWheel += WheelReceived;
            summary.SetBounds(24, 443, 712, 62); Controls.Add(summary);
            KeyDown += delegate(object sender, KeyEventArgs e) { if (keys.Count >= 300) keys.RemoveAt(0); keys.Add(new { key = e.KeyCode.ToString(), modifiers = e.Modifiers.ToString(), down = true }); };
            KeyUp += delegate(object sender, KeyEventArgs e) { if (keys.Count >= 300) keys.RemoveAt(0); keys.Add(new { key = e.KeyCode.ToString(), modifiers = e.Modifiers.ToString(), down = false }); };
            timer.Interval = 100; timer.Tick += delegate { Save(); }; timer.Start();
            Shown += delegate {
                // Limit activation to this purpose-built receiver. Do not attach
                // threads or change the privilege/foreground policy of other apps.
                WindowState = FormWindowState.Normal; TopMost = true;
                SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
                BringToFront(); Activate(); activationAccepted = SetForegroundWindow(Handle);
                editor.Focus(); Save();
            };
            FormClosed += delegate { Save(); };
        }
        private void LogMouse(string type, MouseEventArgs e) { if (mouse.Count >= 300) mouse.RemoveAt(0); mouse.Add(new { type = type, x = e.X, y = e.Y, button = e.Button.ToString(), clicks = e.Clicks }); }
        private void WheelReceived(object sender, MouseEventArgs e) { wheelEvents++; wheelDelta += e.Delta; LogMouse("wheel", e); }
        private void Save() {
            summary.Text = "Clicks: " + clicks + "   Wheel: " + wheelEvents + "   Drag moves: " + dragMoves + "   Mouse releases: " + mouseUps + "\r\n" + (failure ?? "Writing receiver proof to " + output);
            try {
                string directory = Path.GetDirectoryName(output); if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
                IntPtr foregroundWindow = GetForegroundWindow(); uint foregroundPID; GetWindowThreadProcessId(foregroundWindow, out foregroundPID);
                StringBuilder foregroundTitle = new StringBuilder(512); GetWindowText(foregroundWindow, foregroundTitle, foregroundTitle.Capacity);
                int cloaked = -1; int cloakResult = DwmGetWindowAttribute(Handle, 14, out cloaked, 4);
                NativePoint cursor; bool cursorAvailable = GetCursorPos(out cursor);
                NativeRect clip; bool clipAvailable = GetClipCursor(out clip);
                object value = new { type = "windows_receiver", updatedAt = DateTime.UtcNow.ToString("o"), processID = System.Diagnostics.Process.GetCurrentProcess().Id,
                    sessionID = System.Diagnostics.Process.GetCurrentProcess().SessionId, hwnd = Handle.ToInt64(), foreground = foregroundWindow == Handle,
                    foregroundHWND = foregroundWindow.ToInt64(), foregroundPID = foregroundPID, foregroundTitle = foregroundTitle.ToString(),
                    visible = Visible, nativeVisible = IsWindowVisible(Handle), topMost = TopMost, minimized = IsIconic(Handle), windowState = WindowState.ToString(),
                    dwmCloaked = cloakResult == 0 ? cloaked : -1, dwmResult = cloakResult, activationAccepted = activationAccepted,
                    cursor = new { available = cursorAvailable, x = cursor.X, y = cursor.Y },
                    cursorClip = new { available = clipAvailable, left = clip.Left, top = clip.Top, right = clip.Right, bottom = clip.Bottom },
                    desktopEnvironment = InputEnvironment(),
                    focusedControl = ActiveControl == editor ? "editor" : ActiveControl == clickButton ? "clickButton" : ActiveControl == dragPanel ? "dragPanel" : "other",
                    form = BoundsOf(this), editor = BoundsOf(editor), clickButton = BoundsOf(clickButton), dragPanel = BoundsOf(dragPanel),
                    text = editor.Text, clicks = clicks, rightClicks = rightClicks, middleClicks = middleClicks,
                    wheelEvents = wheelEvents, wheelDelta = wheelDelta, dragMoves = dragMoves, mouseDowns = mouseDowns, mouseUps = mouseUps, dragging = dragging,
                    dragStart = new { x = dragStart.X, y = dragStart.Y }, dragEnd = new { x = dragEnd.X, y = dragEnd.Y },
                    leftButtonDown = (GetAsyncKeyState(1) & 0x8000) != 0, controlDown = (GetAsyncKeyState(0x11) & 0x8000) != 0,
                    shiftDown = (GetAsyncKeyState(0x10) & 0x8000) != 0, altDown = (GetAsyncKeyState(0x12) & 0x8000) != 0,
                    keyEvents = keys, mouseEvents = mouse };
                // Read sharing lets the SSH verifier inspect while this window writes.
                byte[] bytes = new UTF8Encoding(false).GetBytes(serializer.Serialize(value));
                using (FileStream stream = new FileStream(output, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) stream.Write(bytes, 0, bytes.Length);
                failure = null;
            } catch (Exception error) { failure = error.Message; }
        }
        [STAThread] private static void Main(string[] args) {
            string path = Path.Combine(Environment.CurrentDirectory, ".run", "windows-receiver.json");
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--output") path = args[++i];
            SetProcessDPIAware(); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new ReceiverWindow(path));
        }
    }
}
