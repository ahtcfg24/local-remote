// Windows interactive worker. stdin: UTF-8 JSONL; stdout: [F|J][uint32 BE][payload].
// Built with the Windows .NET Framework compiler; no downloaded dependencies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace LocalRemote.Windows {
    internal static class InputDebug {
        private static readonly bool enabled = Environment.GetEnvironmentVariable("AGENT_DEBUG_INPUT") == "1" || File.Exists(Path.Combine(Environment.CurrentDirectory, ".run", "windows-input-debug"));
        internal static bool Suppress;
        internal static bool Enabled { get { return enabled && !Suppress; } }
        internal static void Trace(string message) { if (Enabled) Console.Error.WriteLine("[windows-input " + DateTime.UtcNow.ToString("o") + "] " + message); }
    }
    internal static class Native {
        private static int debugPacketDumped;
        internal const uint Mouse = 0, Keyboard = 1;
        internal const uint Move = 0x0001, LeftDown = 0x0002, LeftUp = 0x0004,
            RightDown = 0x0008, RightUp = 0x0010, MiddleDown = 0x0020, MiddleUp = 0x0040,
            Wheel = 0x0800, HWheel = 0x1000, VirtualDesk = 0x4000, Absolute = 0x8000;
        internal const uint KeyUp = 2, Unicode = 4, Extended = 1;
        [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct MonitorInfo {
            public int Size; public Rect Monitor, Work; public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct MouseInput {
            public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct KeyboardInput {
            public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Explicit)] internal struct InputUnion {
            [FieldOffset(0)] public MouseInput Mouse;
            [FieldOffset(0)] public KeyboardInput Keyboard;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct Input { public uint Type; public InputUnion Value; }
        [StructLayout(LayoutKind.Sequential)] internal struct CursorInfo {
            public int Size, Flags; public IntPtr Cursor; public Point Position;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IconInfo {
            [MarshalAs(UnmanagedType.Bool)] public bool IsIcon;
            public uint HotspotX, HotspotY; public IntPtr Mask, Color;
        }
        internal delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);
        [DllImport("user32.dll")] internal static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
        [DllImport("shcore.dll")] internal static extern int SetProcessDpiAwareness(int awareness);
        [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] internal static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", ExactSpelling = true, SetLastError = true)] internal static extern bool GetUserObjectInformationRaw(IntPtr handle, int index, IntPtr value, int length, out int needed);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr OpenWindowStation(string name, bool inherit, uint access);
        [DllImport("user32.dll")] internal static extern bool CloseWindowStation(IntPtr station);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] internal static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out uint length);
        [DllImport("wtsapi32.dll")] internal static extern void WTSFreeMemory(IntPtr buffer);
        [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] internal static extern bool GetCursorInfo(ref CursorInfo info);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetClipCursor(out Rect rect);
        [DllImport("user32.dll")] internal static extern IntPtr GetThreadDesktop(uint threadID);
        [DllImport("user32.dll")] internal static extern IntPtr GetProcessWindowStation();
        [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", EntryPoint = "SetLastError", ExactSpelling = true)] internal static extern void ClearLastError(uint error);
        [DllImport("ntdll.dll", EntryPoint = "NtQueryObject", ExactSpelling = true)] internal static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr buffer, uint length, out uint needed);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processID);
        [DllImport("user32.dll")] internal static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
        [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll", SetLastError = true)] internal static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
        [DllImport("user32.dll")] internal static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
        [DllImport("user32.dll")] internal static extern IntPtr GetKeyboardLayout(uint threadID);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern short VkKeyScanEx(char character, IntPtr layout);
        internal static void SetDpi() {
            try { if (SetProcessDpiAwareness(2) >= 0) return; } catch (DllNotFoundException) {} catch (EntryPointNotFoundException) {}
            SetProcessDPIAware();
        }
        internal static Input Key(ushort key, bool up, uint flags) {
            Input value = new Input(); value.Type = Keyboard;
            value.Value.Keyboard = new KeyboardInput { Key = key, Flags = flags | (up ? KeyUp : 0) }; return value;
        }
        internal static Input Character(char character, bool up) {
            Input value = Key(0, up, Unicode); value.Value.Keyboard.Scan = character; return value;
        }
        internal static Input Pointer(int x, int y, uint flags, int data) {
            Input value = new Input(); value.Type = Mouse;
            value.Value.Mouse = new MouseInput { X = x, Y = y, Flags = flags, Data = unchecked((uint)data) }; return value;
        }
        internal static void Send(params Input[] inputs) {
            if (inputs.Length == 0) return;
            if (InputDebug.Enabled && inputs[0].Type == Mouse && (inputs[0].Value.Mouse.Flags & Move) != 0 && Interlocked.CompareExchange(ref debugPacketDumped, 1, 0) == 0) InputDebug.Trace("mouseABI inputSize=" + Marshal.SizeOf(typeof(Input)) + " mouseSize=" + Marshal.SizeOf(typeof(MouseInput)) + " unionOffset=" + Marshal.OffsetOf(typeof(Input), "Value") + " flagsOffset=" + Marshal.OffsetOf(typeof(MouseInput), "Flags") + " bytes=" + BitConverter.ToString(Bytes(inputs[0])));
            ClearLastError(0); uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))); int error = Marshal.GetLastWin32Error();
            if (InputDebug.Enabled && (inputs[0].Type == Mouse || sent != inputs.Length)) InputDebug.Trace("SendInput type=" + inputs[0].Type + " requested=" + inputs.Length + " accepted=" + sent + " error=" + error + (inputs[0].Type == Mouse ? " mouse=" + inputs[0].Value.Mouse.X + "," + inputs[0].Value.Mouse.Y + " flags=" + inputs[0].Value.Mouse.Flags.ToString("X") + " data=" + inputs[0].Value.Mouse.Data : ""));
            if (sent != inputs.Length) throw new InvalidOperationException("Windows rejected input injection (" + sent + "/" + inputs.Length + ", error " + error + "). Keep the session unlocked and run the target application at the same privilege level.");
        }
        internal static byte[] Bytes(Input value) {
            int size = Marshal.SizeOf(typeof(Input)); IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                byte[] result = new byte[size]; Marshal.Copy(result, 0, memory, size);
                Marshal.StructureToPtr(value, memory, false); Marshal.Copy(memory, result, 0, size); return result;
            } finally { Marshal.FreeHGlobal(memory); }
        }
        internal static string ObjectName(IntPtr handle) { StringBuilder name = new StringBuilder(256); int needed; return GetUserObjectInformation(handle, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "unavailable"; }
        internal static int? ObjectValue(IntPtr handle, int index, int size, int offset) {
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try { Marshal.Copy(new byte[size], 0, buffer, size); int needed; return GetUserObjectInformationRaw(handle, index, buffer, size, out needed) ? (int?)Marshal.ReadInt32(buffer, offset) : null; }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        internal static object ObjectAccess(IntPtr handle, uint writeMask) {
            const int basicSize = 56;
            IntPtr buffer = Marshal.AllocHGlobal(basicSize);
            try {
                Marshal.Copy(new byte[basicSize], 0, buffer, basicSize); uint needed;
                int status = NtQueryObject(handle, 0, buffer, basicSize, out needed);
                uint access = status >= 0 ? unchecked((uint)Marshal.ReadInt32(buffer, 4)) : 0;
                return new { available = status >= 0, ntstatus = "0x" + unchecked((uint)status).ToString("X8"), returnedBytes = needed,
                    grantedAccess = status >= 0 ? "0x" + access.ToString("X8") : null, hasWriteAccess = status >= 0 ? (object)((access & writeMask) != 0) : null };
            } catch (DllNotFoundException) { return new { available = false, error = "NtQueryObject is unavailable." }; }
            catch (EntryPointNotFoundException) { return new { available = false, error = "NtQueryObject is unavailable." }; }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        internal static object InputEnvironmentProbe() {
            IntPtr threadDesktop = GetThreadDesktop(GetCurrentThreadId()), station = GetProcessWindowStation();
            string threadName = ObjectName(threadDesktop), stationName = ObjectName(station);
            int? threadIO = ObjectValue(threadDesktop, 6, 4, 0), stationFlags = ObjectValue(station, 1, 12, 8);
            IntPtr input = OpenInputDesktop(0, false, 0x0001); int inputError = input == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            string inputName = "unavailable"; int? inputIO = null;
            try { if (input != IntPtr.Zero) { inputName = ObjectName(input); inputIO = ObjectValue(input, 6, 4, 0); } }
            finally { if (input != IntPtr.Zero) CloseDesktop(input); }
            // Request and close handles only; never change a DACL, bind a new
            // station/desktop, or modify the global input state.
            IntPtr writeStation = OpenWindowStation(stationName, false, 0x0010); int stationWriteError = writeStation == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            bool stationWrite = writeStation != IntPtr.Zero; if (stationWrite) CloseWindowStation(writeStation);
            IntPtr writeDesktop = OpenDesktop(threadName, 0, false, 0x0080); int desktopWriteError = writeDesktop == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            bool desktopWrite = writeDesktop != IntPtr.Zero; if (desktopWrite) CloseDesktop(writeDesktop);
            return new { threadDesktop = threadName, threadReceivesInput = threadIO.HasValue ? (object)(threadIO.Value != 0) : null,
                inputDesktop = inputName, inputReceivesInput = inputIO.HasValue ? (object)(inputIO.Value != 0) : null, inputOpenError = inputError,
                station = stationName, stationFlags = stationFlags, stationVisible = stationFlags.HasValue ? (object)((stationFlags.Value & 1) != 0) : null,
                currentStationAccess = ObjectAccess(station, 0x0010), currentThreadDesktopAccess = ObjectAccess(threadDesktop, 0x0080),
                canOpenStationWriteAttributes = stationWrite, stationWriteError = stationWriteError, canOpenDesktopWriteObjects = desktopWrite, desktopWriteError = desktopWriteError };
        }
        internal static bool ExtendedKey(ushort key) {
            return (key >= 0x21 && key <= 0x2E) || key == 0x5B || key == 0x5C || key == 0xA3 || key == 0xA5;
        }
    }

    internal sealed class PacketOutput : IDisposable {
        private readonly object gate = new object();
        private readonly Queue<byte[]> events = new Queue<byte[]>();
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly Stream stream = Console.OpenStandardOutput();
        private readonly Thread writer;
        private byte[] frame;
        private bool stopping;
        internal PacketOutput() { writer = new Thread(WriteLoop) { IsBackground = true, Name = "native-output" }; writer.Start(); }
        internal void Json(object value) {
            byte[] bytes;
            lock (serializer) { bytes = Encoding.UTF8.GetBytes(serializer.Serialize(value)); }
            lock (gate) { if (stopping || events.Count >= 256) return; events.Enqueue(bytes); Monitor.Pulse(gate); }
        }
        internal void Frame(byte[] bytes) { lock (gate) { if (stopping) return; frame = bytes; Monitor.Pulse(gate); } }
        internal void DiscardFrame() { lock (gate) { frame = null; } }
        private void WriteLoop() {
            try {
                while (true) {
                    byte[] bytes; byte type;
                    lock (gate) {
                        while (!stopping && events.Count == 0 && frame == null) Monitor.Wait(gate);
                        if (events.Count > 0) { bytes = events.Dequeue(); type = 0x4A; }
                        else if (frame != null) { bytes = frame; frame = null; type = 0x46; }
                        else return;
                    }
                    uint length = (uint)bytes.Length;
                    byte[] header = new byte[] { type, (byte)(length >> 24), (byte)(length >> 16), (byte)(length >> 8), (byte)length };
                    stream.Write(header, 0, header.Length); stream.Write(bytes, 0, bytes.Length); stream.Flush();
                }
            } catch (IOException) { Program.RequestStop(); } catch (ObjectDisposedException) { Program.RequestStop(); }
        }
        public void Dispose() { lock (gate) { frame = null; stopping = true; Monitor.PulseAll(gate); } writer.Join(1000); }
    }

    internal sealed class Display {
        internal string ID; internal Rectangle Bounds; internal bool Primary;
        internal object Status() { return new { id = ID, name = ID, width = Bounds.Width, height = Bounds.Height, originX = Bounds.X, originY = Bounds.Y, primary = Primary }; }
        internal static List<Display> All() {
            List<Display> displays = new List<Display>();
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Native.Rect rect, IntPtr data) {
                Native.MonitorInfo info = new Native.MonitorInfo(); info.Size = Marshal.SizeOf(typeof(Native.MonitorInfo));
                if (Native.GetMonitorInfo(monitor, ref info)) displays.Add(new Display { ID = info.Device, Bounds = Rectangle.FromLTRB(info.Monitor.Left, info.Monitor.Top, info.Monitor.Right, info.Monitor.Bottom), Primary = (info.Flags & 1) != 0 });
                return true;
            }, IntPtr.Zero);
            return displays;
        }
        internal Point Point(double x, double y) { return new Point(Bounds.Left + ClampCoordinate(x, Bounds.Width), Bounds.Top + ClampCoordinate(y, Bounds.Height)); }
        internal static int ClampCoordinate(double value, int size) { return (int)Math.Round(Math.Min(Math.Max(0, value), Math.Max(0, size - 1))); }
    }

    internal sealed class DesktopState {
        private static readonly int CurrentSessionID = Process.GetCurrentProcess().SessionId;
        internal bool Available; internal string Name, Error; internal int SessionID;
        internal static DesktopState Read() {
            DesktopState result = new DesktopState { SessionID = CurrentSessionID, Name = "" };
            if (!Environment.UserInteractive || result.SessionID == 0) { result.Error = "Windows capture requires a logged-in interactive user session; a service or SSH session cannot control the desktop."; return result; }
            IntPtr state; uint length;
            if (!Native.WTSQuerySessionInformation(IntPtr.Zero, result.SessionID, 8, out state, out length)) { result.Error = "Windows session state is unavailable."; return result; }
            try { if (length < 4 || Marshal.ReadInt32(state) != 0) { result.Error = "The Windows user session is disconnected. Reconnect and unlock it to resume control."; return result; } }
            finally { Native.WTSFreeMemory(state); }
            IntPtr desktop = Native.OpenInputDesktop(0, false, 0x0001);
            if (desktop == IntPtr.Zero) { result.Error = "The Windows desktop is locked or showing a secure prompt. Unlock it locally to resume control."; return result; }
            try {
                StringBuilder name = new StringBuilder(256); int needed;
                if (!Native.GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) { result.Error = "Windows input desktop is unavailable."; return result; }
                result.Name = name.ToString();
                if (!String.Equals(result.Name, "Default", StringComparison.OrdinalIgnoreCase)) { result.Error = "Windows secure desktop cannot be captured or controlled. Return to the unlocked desktop to resume."; return result; }
                result.Available = true; return result;
            } finally { Native.CloseDesktop(desktop); }
        }
    }

    internal sealed class Capture : IDisposable {
        private readonly object gate = new object();
        private readonly PacketOutput output;
        private readonly Thread thread;
        private readonly ManualResetEvent wake = new ManualResetEvent(false);
        private volatile bool stopping;
        private Display display;
        private List<Display> displays = new List<Display>();
        private DesktopState desktop = new DesktopState { Error = "Capture is starting.", Name = "" };
        private int fps = 15, maxWidth = 1920, frameWidth, frameHeight;
        private double quality = 0.6;
        private string requestedDisplay = Environment.GetEnvironmentVariable("AGENT_DISPLAY");
        private bool capturing;
        private string error;
        private long revision;
        internal Action<bool> AvailabilityChanged;
        internal Capture(PacketOutput output) {
            this.output = output;
            fps = Values.Bounded(Values.Number(Environment.GetEnvironmentVariable("AGENT_FPS")), fps, 1, 30);
            maxWidth = Values.Bounded(Values.Number(Environment.GetEnvironmentVariable("AGENT_MAX_WIDTH")), maxWidth, 640, 3840);
            double? q = Values.Number(Environment.GetEnvironmentVariable("AGENT_QUALITY")); if (q.HasValue) quality = Math.Min(0.95, Math.Max(0.2, q.Value));
            thread = new Thread(Loop) { IsBackground = true, Name = "screen-capture" }; thread.Start();
        }
        internal bool Available { get { lock (gate) { return capturing && desktop.Available; } } }
        internal Point Point(double x, double y) { lock (gate) { if (display == null) throw new InvalidOperationException("No captured display is available."); return display.Point(x, y); } }
        internal void Config(IDictionary<string, object> command) {
            lock (gate) {
                fps = Values.Bounded(Values.GetNumber(command, "fps"), fps, 1, 30);
                maxWidth = Values.Bounded(Values.GetNumber(command, "maxWidth"), maxWidth, 640, 3840);
                double? q = Values.GetNumber(command, "quality"); if (q.HasValue) quality = Math.Min(0.95, Math.Max(0.2, q.Value));
                object id; if (command.TryGetValue("displayID", out id) && id is string) requestedDisplay = (string)id;
                revision++;
            }
            wake.Set();
        }
        internal void Status() {
            lock (gate) {
                Rectangle bounds = display == null ? Rectangle.Empty : display.Bounds;
                List<object> available = new List<object>(); foreach (Display value in displays) available.Add(value.Status());
                output.Json(new { type = "status", platform = "win32", width = bounds.Width, height = bounds.Height,
                    displayID = display == null ? null : display.ID, displayName = display == null ? "" : display.ID,
                    originX = bounds.X, originY = bounds.Y, frameWidth = frameWidth, frameHeight = frameHeight,
                    screenRecording = desktop.Available, accessibilityTrusted = desktop.Available,
                    inputAvailable = capturing && desktop.Available, capturing = capturing, fps = fps, quality = quality, maxWidth = maxWidth,
                    captureError = error ?? desktop.Error, sessionID = desktop.SessionID, interactiveSession = desktop.Available,
                    inputDesktop = desktop.Name, displays = available });
            }
        }
        private void State(Display selected, List<Display> all, DesktopState state, bool ready, string failure, int width, int height) {
            bool changed, availability, geometryChanged;
            lock (gate) {
                geometryChanged = (display == null) != (selected == null) || (display != null && selected != null && (display.ID != selected.ID || display.Bounds != selected.Bounds));
                changed = capturing != ready || desktop.Available != state.Available || desktop.Name != state.Name || desktop.Error != state.Error || error != failure || frameWidth != width || frameHeight != height || geometryChanged;
                availability = capturing != ready;
                display = selected; displays = all; desktop = state; capturing = ready; error = failure; frameWidth = width; frameHeight = height;
            }
            if (changed) {
                output.DiscardFrame();
                if (geometryChanged && AvailabilityChanged != null) AvailabilityChanged(false);
                if (availability && AvailabilityChanged != null) AvailabilityChanged(ready);
                Status();
            }
        }
        private void Loop() {
            ImageCodecInfo codec = null; foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders()) if (candidate.MimeType == "image/jpeg") { codec = candidate; break; }
            byte[] previous = null; DateTime lastFrame = DateTime.MinValue; long previousRevision = -1;
            while (!stopping) {
                Stopwatch timer = Stopwatch.StartNew();
                int currentFPS, currentWidth; double currentQuality; string desired; long currentRevision;
                lock (gate) { currentFPS = fps; currentWidth = maxWidth; currentQuality = quality; desired = requestedDisplay; currentRevision = revision; }
                if (currentRevision != previousRevision) { previous = null; previousRevision = currentRevision; }
                DesktopState state = DesktopState.Read(); List<Display> all = Display.All(); Display selected = null;
                foreach (Display candidate in all) if (!String.IsNullOrEmpty(desired) && candidate.ID == desired) selected = candidate;
                if (selected == null) foreach (Display candidate in all) if (candidate.Primary) { selected = candidate; break; }
                if (selected == null && all.Count > 0) selected = all[0];
                if (!state.Available || selected == null) {
                    State(selected, all, state, false, selected == null ? "No Windows display is available." : null, 0, 0); previous = null;
                } else try {
                    int width = Math.Min(currentWidth, selected.Bounds.Width);
                    int height = Math.Max(1, (int)Math.Round(selected.Bounds.Height * (double)width / selected.Bounds.Width));
                    byte[] bytes;
                    using (Bitmap source = new Bitmap(selected.Bounds.Width, selected.Bounds.Height, PixelFormat.Format24bppRgb)) {
                        using (Graphics graphics = Graphics.FromImage(source)) {
                            CopyScreen(graphics, selected.Bounds);
                            DrawCursor(graphics, selected.Bounds);
                        }
                        using (Bitmap resized = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
                            using (Graphics graphics = Graphics.FromImage(resized)) { graphics.InterpolationMode = InterpolationMode.HighQualityBilinear; graphics.DrawImage(source, new Rectangle(0, 0, width, height)); }
                            using (MemoryStream data = new MemoryStream()) using (EncoderParameters parameters = new EncoderParameters(1)) {
                                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Round(currentQuality * 100));
                                resized.Save(data, codec, parameters); bytes = data.ToArray();
                            }
                        }
                    }
                    // Recheck after capture so a lock transition cannot advertise a stale frame as usable.
                    state = DesktopState.Read();
                    if (!state.Available) { State(selected, all, state, false, null, 0, 0); previous = null; }
                    else {
                        State(selected, all, state, true, null, width, height);
                        if (!Equal(previous, bytes) || (DateTime.UtcNow - lastFrame).TotalSeconds >= 2) { output.Frame(bytes); previous = bytes; lastFrame = DateTime.UtcNow; }
                    }
                } catch (Exception exception) {
                    State(selected, all, state, false, "Windows screen capture failed: " + exception.Message, 0, 0); previous = null;
                }
                int delay = Math.Max(1, (state.Available ? 1000 / currentFPS : 1000) - (int)timer.ElapsedMilliseconds);
                wake.WaitOne(delay); wake.Reset();
            }
        }
        private static bool Equal(byte[] a, byte[] b) { if (a == null || b == null || a.Length != b.Length) return false; for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false; return true; }
        private static void CopyScreen(Graphics graphics, Rectangle bounds) {
            IntPtr source = Native.GetDC(IntPtr.Zero); if (source == IntPtr.Zero) throw new InvalidOperationException("The Windows screen device context is unavailable.");
            try {
                IntPtr destination = graphics.GetHdc();
                try {
                    // CAPTUREBLT includes layered/topmost windows in the desktop
                    // image. Graphics.CopyFromScreen's enum validation cannot
                    // reliably accept SourceCopy | CaptureBlt on .NET Framework.
                    if (!Native.BitBlt(destination, 0, 0, bounds.Width, bounds.Height, source, bounds.Left, bounds.Top, 0x00CC0020 | 0x40000000)) throw new InvalidOperationException("BitBlt failed with Windows error " + Marshal.GetLastWin32Error() + ".");
                } finally { graphics.ReleaseHdc(destination); }
            } finally { Native.ReleaseDC(IntPtr.Zero, source); }
        }
        private static void DrawCursor(Graphics graphics, Rectangle bounds) {
            Native.CursorInfo cursor = new Native.CursorInfo(); cursor.Size = Marshal.SizeOf(typeof(Native.CursorInfo));
            if (!Native.GetCursorInfo(ref cursor) || (cursor.Flags & 1) == 0 || !bounds.Contains(cursor.Position.X, cursor.Position.Y)) return;
            Native.IconInfo icon;
            if (!Native.GetIconInfo(cursor.Cursor, out icon)) return;
            try {
                IntPtr dc = graphics.GetHdc();
                try { Native.DrawIconEx(dc, cursor.Position.X - bounds.Left - (int)icon.HotspotX, cursor.Position.Y - bounds.Top - (int)icon.HotspotY, cursor.Cursor, 0, 0, 0, IntPtr.Zero, 3); }
                finally { graphics.ReleaseHdc(dc); }
            } finally { if (icon.Mask != IntPtr.Zero) Native.DeleteObject(icon.Mask); if (icon.Color != IntPtr.Zero) Native.DeleteObject(icon.Color); }
        }
        public void Dispose() { stopping = true; wake.Set(); thread.Join(2000); }
    }

    internal static class Values {
        internal static double? Number(object value) {
            if (value == null || value is bool) return null;
            double result; if (!Double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out result) || Double.IsNaN(result) || Double.IsInfinity(result)) return null;
            return result;
        }
        internal static double? GetNumber(IDictionary<string, object> value, string name) { object result; return value.TryGetValue(name, out result) && !(result is string) ? Number(result) : null; }
        internal static int Bounded(double? value, int fallback, int low, int high) { return value.HasValue ? (int)Math.Min(high, Math.Max(low, value.Value)) : fallback; }
        internal static string Text(IDictionary<string, object> value, string key, string fallback) { object found; return value.TryGetValue(key, out found) && found is string ? (string)found : fallback; }
        internal static List<ushort> Modifiers(IDictionary<string, object> command) {
            List<ushort> result = new List<ushort>(); object value;
            if (command.TryGetValue("modifiers", out value) && !(value is string) && !(value is IDictionary) && value is IEnumerable) foreach (object item in (IEnumerable)value) {
                ushort key = Modifier(item as string); if (key != 0 && !result.Contains(key)) result.Add(key);
            }
            return result;
        }
        internal static ushort Modifier(string value) {
            switch ((value ?? "").ToLowerInvariant()) {
                case "shift": return 0xA0; case "control": case "ctrl": return 0xA2;
                case "option": case "alt": return 0xA4; case "command": case "cmd": case "meta": case "win": case "windows": return 0x5B;
                default: return 0;
            }
        }
        internal static string Button(string value) { return value == "right" ? "right" : value == "middle" || value == "center" ? "middle" : "left"; }
        internal static uint ButtonFlag(string button, bool up) { return button == "right" ? up ? Native.RightUp : Native.RightDown : button == "middle" ? up ? Native.MiddleUp : Native.MiddleDown : up ? Native.LeftUp : Native.LeftDown; }
        internal static ushort NamedKey(string value) {
            switch (value.ToLowerInvariant()) {
                case "enter": case "return": return 0x0D; case "tab": return 0x09; case "space": case " ": return 0x20;
                case "escape": case "esc": return 0x1B; case "backspace": return 0x08;
                case "delete": case "forwarddelete": return 0x2E; case "insert": return 0x2D;
                case "arrowleft": case "left": return 0x25; case "arrowright": case "right": return 0x27;
                case "arrowup": case "up": return 0x26; case "arrowdown": case "down": return 0x28;
                case "home": return 0x24; case "end": return 0x23; case "pageup": return 0x21; case "pagedown": return 0x22;
                case "capslock": return 0x14; case "numlock": return 0x90; case "printscreen": return 0x2C;
                case "contextmenu": return 0x5D; case "pause": return 0x13;
            }
            int function; if (value.StartsWith("f", StringComparison.OrdinalIgnoreCase) && Int32.TryParse(value.Substring(1), out function) && function >= 1 && function <= 24) return (ushort)(0x70 + function - 1);
            return 0;
        }
    }

    internal sealed class InputController : IDisposable {
        private sealed class Job {
            internal IDictionary<string, object> Command; internal bool Pointer; internal long Generation, PointerGeneration;
            internal bool IsRelease, ReleaseAll; internal List<IDictionary<string, object>> ReleaseCommands;
        }
        private sealed class PressedPointer { internal Point Point; internal List<ushort> Modifiers; }
        private readonly object gate = new object();
        private readonly Queue<Job> jobs = new Queue<Job>();
        private readonly Dictionary<string, PressedPointer> pointers = new Dictionary<string, PressedPointer>();
        private readonly HashSet<ushort> heldKeys = new HashSet<ushort>();
        private readonly HashSet<ushort> heldModifiers = new HashSet<ushort>();
        private readonly Thread thread;
        private readonly Capture capture;
        private readonly PacketOutput output;
        private readonly Action<Native.Input[]> send;
        private readonly Action<Point> testMover;
        private bool stopping; private long generation, pointerGeneration; private Job pendingRelease;
        internal InputController(Capture capture, PacketOutput output) : this(capture, output, Native.Send, true) {}
        private InputController(Capture capture, PacketOutput output, Action<Native.Input[]> sender, bool startWorker, Action<Point> mover = null) {
            this.capture = capture; this.output = output; send = sender; testMover = mover;
            thread = startWorker ? new Thread(Loop) { IsBackground = true, Name = "input-injection" } : null;
            if (thread != null) thread.Start();
            // Retry any rejected ups when the interactive desktop returns, before
            // the ready status allows clients to enqueue their next command.
            if (capture != null) capture.AvailabilityChanged = delegate(bool ready) { InputDebug.Trace("capture availability ready=" + ready); Release(true, null); };
        }
        private void Send(params Native.Input[] inputs) { send(inputs); }
        internal void Submit(IDictionary<string, object> command, bool pointer) {
            lock (gate) {
                if (stopping) { Ack(command, false, "Native worker is shutting down."); return; }
                if (jobs.Count >= 128) { Release(true, null); Ack(command, false, "Input queue is full; pending commands were cancelled."); return; }
                jobs.Enqueue(new Job { Command = command, Pointer = pointer, Generation = generation, PointerGeneration = pointerGeneration }); Monitor.Pulse(gate);
                InputDebug.Trace("queued cmd=" + Values.Text(command, "cmd", "") + " jobs=" + jobs.Count + " generation=" + generation + " pointerGeneration=" + pointerGeneration);
            }
        }
        private bool Cancelled(Job job) { lock (gate) { return stopping || job.Generation != generation || (job.Pointer && job.PointerGeneration != pointerGeneration); } }
        internal void Release(bool all, IDictionary<string, object> command) {
            lock (gate) {
                pointerGeneration++; if (all) generation++;
                InputDebug.Trace("release all=" + all + " generation=" + generation + " pointerGeneration=" + pointerGeneration);
                if (pendingRelease == null) {
                    pendingRelease = new Job { IsRelease = true, ReleaseCommands = new List<IDictionary<string, object>>() };
                    jobs.Enqueue(pendingRelease);
                }
                pendingRelease.ReleaseAll |= all;
                if (command != null) {
                    if (pendingRelease.ReleaseCommands.Count < 128) pendingRelease.ReleaseCommands.Add(command);
                    else Ack(command, false, "Release acknowledgement queue is full.");
                }
                Monitor.Pulse(gate);
            }
        }
        private void Loop() {
            InputDebug.Trace("input worker started threadDesktop=" + Native.ObjectName(Native.GetThreadDesktop(Native.GetCurrentThreadId())) + " station=" + Native.ObjectName(Native.GetProcessWindowStation()));
            if (InputDebug.Enabled) InputDebug.Trace("inputEnvironment " + new JavaScriptSerializer().Serialize(Native.InputEnvironmentProbe()));
            while (true) {
                Job job;
                lock (gate) { while (!stopping && jobs.Count == 0) Monitor.Wait(gate); if (stopping && jobs.Count == 0) break; job = jobs.Dequeue(); if (job.IsRelease) pendingRelease = null; }
                try {
                    if (job.IsRelease) {
                        bool released = ReleaseNow(job.ReleaseAll);
                        foreach (IDictionary<string, object> command in job.ReleaseCommands) Ack(command, released, released ? null : "Windows rejected an input release; it will be retried when the desktop is available.");
                        continue;
                    }
                    if (Cancelled(job)) { InputDebug.Trace("cancelled cmd=" + Values.Text(job.Command, "cmd", "") + " expectedGeneration=" + job.Generation + " expectedPointerGeneration=" + job.PointerGeneration + " currentGeneration=" + generation + " currentPointerGeneration=" + pointerGeneration); Ack(job.Command, false, "Input was cancelled when control was released."); continue; }
                    DesktopState desktop = DesktopState.Read();
                    if (!capture.Available || !desktop.Available) { InputDebug.Trace("rejected cmd=" + Values.Text(job.Command, "cmd", "") + " capturing=" + capture.Available + " desktopAvailable=" + desktop.Available + " desktop=" + desktop.Name + " error=" + desktop.Error); Ack(job.Command, false, desktop.Error ?? "No usable screen capture is available."); continue; }
                    InputDebug.Trace("executing cmd=" + Values.Text(job.Command, "cmd", ""));
                    Execute(job);
                    InputDebug.Trace("completed cmd=" + Values.Text(job.Command, "cmd", ""));
                    bool cancelled = Cancelled(job); Ack(job.Command, !cancelled, cancelled ? "Input was cancelled when control was released." : null);
                } catch (Exception exception) {
                    if (job.Command != null) Ack(job.Command, false, exception.Message);
                    output.Json(new { type = "error", message = exception.Message });
                    ReleaseNow(true);
                }
            }
            ReleaseNow(true);
        }
        private void Ack(IDictionary<string, object> command, bool ok, string error) {
            object id; if (command != null && command.TryGetValue("id", out id)) output.Json(new { type = "command_ack", id = id, cmd = Values.Text(command, "cmd", ""), ok = ok, error = error });
        }
        private void Move(Point point) {
            if (testMover != null) { testMover(point); return; }
            Native.Rect confinement;
            if (Native.GetClipCursor(out confinement) && (point.X < confinement.Left || point.X >= confinement.Right || point.Y < confinement.Top || point.Y >= confinement.Bottom)) throw new InvalidOperationException("Windows confines the pointer to " + confinement.Left + "," + confinement.Top + "–" + confinement.Right + "," + confinement.Bottom + ". The requested position is outside that area; finish the application operation that confines it before retrying.");
            int left = Native.GetSystemMetrics(76), top = Native.GetSystemMetrics(77), width = Native.GetSystemMetrics(78), height = Native.GetSystemMetrics(79);
            int x = (int)Math.Round((point.X - left) * 65535.0 / Math.Max(1, width - 1));
            int y = (int)Math.Round((point.Y - top) * 65535.0 / Math.Max(1, height - 1));
            // An opt-in comparison for diagnosing ignored injected movement.
            // Both APIs retain the desktop ACL and ClipCursor restrictions.
            bool cursorAPI = Environment.GetEnvironmentVariable("AGENT_POINTER_API") == "cursorpos" || File.Exists(Path.Combine(Environment.CurrentDirectory, ".run", "windows-pointer-cursorpos"));
            if (InputDebug.Enabled) {
                Native.Point before; bool available = Native.GetCursorPos(out before); uint foregroundPID; Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out foregroundPID);
                Native.Rect clip; bool clipAvailable = Native.GetClipCursor(out clip);
                InputDebug.Trace("Move api=" + (cursorAPI ? "SetCursorPos" : "SendInput") + " target=" + point.X + "," + point.Y + " virtual=" + left + "," + top + "," + width + "," + height + " normalized=" + x + "," + y + " cursorBefore=" + before.X + "," + before.Y + " cursorAvailable=" + available + " foregroundPID=" + foregroundPID + " threadDesktop=" + Native.ObjectName(Native.GetThreadDesktop(Native.GetCurrentThreadId())) + " station=" + Native.ObjectName(Native.GetProcessWindowStation()) + " clipAvailable=" + clipAvailable + " clip=" + clip.Left + "," + clip.Top + "," + clip.Right + "," + clip.Bottom);
            }
            if (cursorAPI) {
                Native.ClearLastError(0);
                if (!Native.SetCursorPos(point.X, point.Y)) throw new InvalidOperationException("Windows rejected pointer movement (error " + Marshal.GetLastWin32Error() + "). Keep the user session active and the desktop unlocked.");
                InputDebug.Trace("SetCursorPos accepted=true");
            } else Send(Native.Pointer(x, y, Native.Move | Native.Absolute | Native.VirtualDesk, 0));
            Stopwatch wait = Stopwatch.StartNew();
            if (InputDebug.Enabled) {
                Native.Point after; bool available = Native.GetCursorPos(out after); InputDebug.Trace("Move cursorImmediate=" + after.X + "," + after.Y + " cursorAvailable=" + available);
                Thread.Sleep(10); available = Native.GetCursorPos(out after); InputDebug.Trace("Move cursorAfter10ms=" + after.X + "," + after.Y + " cursorAvailable=" + available);
                Thread.Sleep(40); available = Native.GetCursorPos(out after); InputDebug.Trace("Move cursorAfter50ms=" + after.X + "," + after.Y + " cursorAvailable=" + available);
            }
            Native.Point actual;
            if (Native.GetCursorPos(out actual) && PointerReached(point, actual)) return;
            while (wait.ElapsedMilliseconds < 50) {
                Thread.Sleep(1);
                if (Native.GetCursorPos(out actual) && PointerReached(point, actual)) return;
            }
            InputDebug.Trace("Move failed target=" + point.X + "," + point.Y + " actual=" + actual.X + "," + actual.Y);
            throw new InvalidOperationException("Windows did not move the pointer to the requested position. The click was cancelled. Check whether the foreground application blocks input or requires administrator privileges.");
        }
        private static bool PointerReached(Point target, Native.Point actual) { return Math.Abs((long)target.X - actual.X) <= 1 && Math.Abs((long)target.Y - actual.Y) <= 1; }
        private void SetModifiers(IEnumerable<ushort> temporary) {
            HashSet<ushort> wanted = new HashSet<ushort>(temporary);
            foreach (PressedPointer pointer in pointers.Values) foreach (ushort key in pointer.Modifiers) wanted.Add(key);
            foreach (ushort key in new List<ushort>(heldModifiers)) if (!wanted.Contains(key)) { Send(Native.Key(key, true, Native.ExtendedKey(key) ? Native.Extended : 0)); heldModifiers.Remove(key); }
            foreach (ushort key in wanted) if (!heldModifiers.Contains(key)) { heldModifiers.Add(key); Send(Native.Key(key, false, Native.ExtendedKey(key) ? Native.Extended : 0)); }
        }
        private void Down(Point point, string button, List<ushort> modifiers) {
            Move(point); pointers[button] = new PressedPointer { Point = point, Modifiers = modifiers }; SetModifiers(new ushort[0]); Send(Native.Pointer(0, 0, Values.ButtonFlag(button, false), 0));
        }
        private void Up(Point point, string button) {
            try { Move(point); }
            finally { Send(Native.Pointer(0, 0, Values.ButtonFlag(button, true), 0)); pointers.Remove(button); SetModifiers(new ushort[0]); }
        }
        private void Press(ushort key, List<ushort> modifiers) {
            SetModifiers(modifiers); heldKeys.Add(key);
            uint flags = Native.ExtendedKey(key) ? Native.Extended : 0;
            try { Send(Native.Key(key, false, flags), Native.Key(key, true, flags)); heldKeys.Remove(key); }
            finally {
                // A partially accepted SendInput array may leave the down event held.
                // Retain tracking if the emergency up also fails, so ReleaseNow retries.
                if (heldKeys.Contains(key)) { try { Send(Native.Key(key, true, flags)); heldKeys.Remove(key); } catch {} }
                SetModifiers(new ushort[0]);
            }
        }
        private void Text(string value, Job job) {
            for (int i = 0; i < value.Length; i++) {
                if (Cancelled(job)) return;
                if ((i & 63) == 0 && !DesktopState.Read().Available) throw new InvalidOperationException("Windows desktop became unavailable during text injection.");
                char c = value[i];
                if (c == '\r' || c == '\n') {
                    if (c == '\r' && i + 1 < value.Length && value[i + 1] == '\n') i++;
                    Press(0x0D, new List<ushort>());
                } else if (Char.IsHighSurrogate(c) && i + 1 < value.Length && Char.IsLowSurrogate(value[i + 1])) {
                    char low = value[++i]; Send(Native.Character(c, false), Native.Character(c, true), Native.Character(low, false), Native.Character(low, true));
                } else { Send(Native.Character(c, false), Native.Character(c, true)); }
                // Windows' default timer quantum can turn Sleep(1) into 15.6 ms.
                // Yield per 16 UTF-16 units so a 4000-character request stays bounded
                // while the target application's message loop drains its input queue.
                if ((i & 15) == 15 && i < value.Length - 1) Thread.Sleep(1);
            }
        }
        private void Execute(Job job) {
            IDictionary<string, object> command = job.Command; string cmd = Values.Text(command, "cmd", "");
            List<ushort> modifiers = Values.Modifiers(command);
            if (job.Pointer && cmd != "wheel") {
                double? x = Values.GetNumber(command, "x"), y = Values.GetNumber(command, "y"); if (!x.HasValue || !y.HasValue) throw new ArgumentException("Pointer commands require finite x and y.");
                Point point = capture.Point(x.Value, y.Value); string button = Values.Button(Values.Text(command, "button", "left"));
                switch (cmd) {
                    case "move": Move(point); break;
                    case "down": Down(point, button, modifiers); break;
                    case "up": Up(point, button); break;
                    case "drag": PressedPointer pointer; if (pointers.TryGetValue(button, out pointer)) { pointer.Point = point; pointer.Modifiers = modifiers; SetModifiers(new ushort[0]); Move(point); } break;
                    case "click":
                        int count = Values.Bounded(Values.GetNumber(command, "count"), 1, 1, 3);
                        for (int i = 0; i < count && !Cancelled(job); i++) { Down(point, button, modifiers); Thread.Sleep(20); Up(point, button); if (i < count - 1) Thread.Sleep(60); }
                        break;
                }
            } else if (cmd == "wheel") {
                double? dx = Values.GetNumber(command, "dx"), dy = Values.GetNumber(command, "dy"); if (!dx.HasValue || !dy.HasValue) throw new ArgumentException("Wheel commands require finite dx and dy.");
                int horizontal = (int)Math.Round(Math.Min(32000, Math.Max(-32000, dx.Value))), vertical = (int)Math.Round(Math.Min(32000, Math.Max(-32000, -dy.Value)));
                if (vertical != 0) Send(Native.Pointer(0, 0, Native.Wheel, vertical)); if (horizontal != 0) Send(Native.Pointer(0, 0, Native.HWheel, horizontal));
            } else if (cmd == "text") {
                string text = Values.Text(command, "text", ""); if (Encoding.UTF8.GetByteCount(text) > 32768) throw new ArgumentException("Text command exceeds 32768 UTF-8 bytes."); Text(text, job);
            } else if (cmd == "key") {
                string key = Values.Text(command, "key", ""); if (key.Length == 0 || Encoding.UTF8.GetByteCount(key) > 64) throw new ArgumentException("Key command requires a valid key.");
                ushort code = Values.NamedKey(key);
                if (code == 0 && key.Length == 1) {
                    short mapped = Native.VkKeyScanEx(key[0], Native.GetKeyboardLayout(0));
                    if (mapped != -1) {
                        code = (ushort)(mapped & 255); int flags = (mapped >> 8) & 255;
                        if ((flags & 1) != 0 && !modifiers.Contains(0xA0)) modifiers.Add(0xA0);
                        if ((flags & 2) != 0 && !modifiers.Contains(0xA2)) modifiers.Add(0xA2);
                        if ((flags & 4) != 0 && !modifiers.Contains(0xA4)) modifiers.Add(0xA4);
                    }
                }
                int repeat = Values.Bounded(Values.GetNumber(command, "repeat"), 1, 1, 2000);
                for (int i = 0; i < repeat && !Cancelled(job); i++) {
                    if (code != 0) Press(code, modifiers);
                    else if (modifiers.Count == 0 && (key.Length == 1 || (key.Length == 2 && Char.IsSurrogatePair(key, 0)))) Text(key, job);
                    else throw new ArgumentException("Unsupported Windows key: " + key);
                    if (i < repeat - 1) Thread.Sleep(1);
                }
            }
        }
        private bool ReleaseNow(bool all) {
            foreach (string button in new List<string>(pointers.Keys)) {
                try { Send(Native.Pointer(0, 0, Values.ButtonFlag(button, true), 0)); pointers.Remove(button); } catch {}
            }
            if (all) foreach (ushort key in new List<ushort>(heldKeys)) {
                try { Send(Native.Key(key, true, Native.ExtendedKey(key) ? Native.Extended : 0)); heldKeys.Remove(key); } catch {}
            }
            foreach (ushort key in new List<ushort>(heldModifiers)) {
                try { Send(Native.Key(key, true, Native.ExtendedKey(key) ? Native.Extended : 0)); heldModifiers.Remove(key); } catch {}
            }
            return pointers.Count == 0 && heldModifiers.Count == 0 && (!all || heldKeys.Count == 0);
        }
        internal static void SelfTest() {
            bool reject = true; int ups = 0;
            InputController input = new InputController(null, null, delegate(Native.Input[] inputs) { if (reject) throw new InvalidOperationException("synthetic rejected input"); ups += inputs.Length; }, false);
            input.pointers.Add("left", new PressedPointer { Modifiers = new List<ushort>(), Point = new Point(0, 0) });
            input.heldKeys.Add(0x41); input.heldModifiers.Add(0xA2);
            if (input.ReleaseNow(true) || input.pointers.Count != 1 || input.heldKeys.Count != 1 || input.heldModifiers.Count != 1) throw new Exception("FAIL: rejected input releases retain state");
            reject = false;
            if (!input.ReleaseNow(true) || ups != 3) throw new Exception("FAIL: desktop recovery retries every held input");
            Job text = new Job { Generation = input.generation }, pointer = new Job { Generation = input.generation, PointerGeneration = input.pointerGeneration, Pointer = true };
            input.Release(false, null);
            if (input.Cancelled(text) || !input.Cancelled(pointer)) throw new Exception("FAIL: pointer release preserves accepted text");
            input.Release(true, null);
            if (!input.Cancelled(text)) throw new Exception("FAIL: full release cancels text");
            for (int i = 0; i < 10000; i++) input.Release(false, null);
            if (input.jobs.Count != 1) throw new Exception("FAIL: repeated releases remain bounded");
            input.Dispose();
            List<Native.Input> posted = new List<Native.Input>();
            InputController rejectedMove = new InputController(null, null, delegate(Native.Input[] values) { posted.AddRange(values); }, false, delegate(Point point) { throw new InvalidOperationException("synthetic rejected pointer movement"); });
            bool downFailed = false;
            try { rejectedMove.Down(new Point(10, 10), "left", new List<ushort> { 0xA2 }); } catch (InvalidOperationException) { downFailed = true; }
            if (!downFailed || posted.Count != 0 || rejectedMove.pointers.Count != 0 || rejectedMove.heldModifiers.Count != 0) throw new Exception("FAIL: failed pointer move must not press a button or modifier at the wrong location");
            rejectedMove.pointers.Add("left", new PressedPointer { Point = new Point(0, 0), Modifiers = new List<ushort> { 0xA2 } }); rejectedMove.heldModifiers.Add(0xA2);
            bool upFailed = false;
            try { rejectedMove.Up(new Point(10, 10), "left"); } catch (InvalidOperationException) { upFailed = true; }
            if (!upFailed || posted.Count != 2 || posted[0].Type != Native.Mouse || posted[0].Value.Mouse.Flags != Native.LeftUp || posted[1].Type != Native.Keyboard || posted[1].Value.Keyboard.Key != 0xA2 || (posted[1].Value.Keyboard.Flags & Native.KeyUp) == 0 || rejectedMove.pointers.Count != 0 || rejectedMove.heldModifiers.Count != 0) throw new Exception("FAIL: pointer up must release the button and modifier even when movement fails");
            if (!PointerReached(new Point(-100, 10), new Native.Point { X = -99, Y = 11 }) || PointerReached(new Point(10, 10), new Native.Point { X = 12, Y = 10 })) throw new Exception("FAIL: pointer verification tolerance");
            rejectedMove.Dispose();
        }
        public void Dispose() { lock (gate) { generation++; pointerGeneration++; stopping = true; Monitor.PulseAll(gate); } if (thread != null) thread.Join(2000); else ReleaseNow(true); }
    }

    internal static class Program {
        private static volatile bool stopping;
        internal static void RequestStop() { stopping = true; }
        private static void Check(bool result, string message) { if (!result) throw new Exception("FAIL: " + message); }
        private static void SelfTest() {
            Check(Marshal.SizeOf(typeof(Native.Input)) == (IntPtr.Size == 8 ? 40 : 28), "SendInput ABI size");
            Check(Marshal.OffsetOf(typeof(Native.Input), "Value").ToInt32() == (IntPtr.Size == 8 ? 8 : 4) && Marshal.OffsetOf(typeof(Native.MouseInput), "Flags").ToInt32() == 12, "SendInput ABI field offsets");
            byte[] mouseBytes = Native.Bytes(Native.Pointer(12345, -6789, Native.Move | Native.Absolute | Native.VirtualDesk, 0));
            int unionOffset = IntPtr.Size == 8 ? 8 : 4;
            Check(BitConverter.ToUInt32(mouseBytes, 0) == Native.Mouse && BitConverter.ToInt32(mouseBytes, unionOffset) == 12345 && BitConverter.ToInt32(mouseBytes, unionOffset + 4) == -6789 && BitConverter.ToUInt32(mouseBytes, unionOffset + 8) == 0 && BitConverter.ToUInt32(mouseBytes, unionOffset + 12) == 0xC001, "marshaled mouse packet bytes");
            Display display = new Display { Bounds = new Rectangle(-1920, 200, 1920, 1080) };
            Check(display.Point(100, 50) == new Point(-1820, 250), "display-relative coordinate mapping");
            Check(display.Point(-100, 5000) == new Point(-1920, 1279), "display coordinate clamping");
            Check(Values.Number(true) == null && Values.Number("NaN") == null && Values.Number("Infinity") == null, "invalid numeric values");
            Check(Values.Bounded(99999, 15, 1, 30) == 30 && Values.Bounded(null, 15, 1, 30) == 15, "config bounds");
            Check(Values.Modifier("ctrl") == 0xA2 && Values.Modifier("command") == 0x5B && Values.NamedKey("F12") == 0x7B && Values.NamedKey("ForwardDelete") == 0x2E, "Windows keyboard mapping");
            Native.Input character = Native.Character('\u4E2D', false);
            Check(character.Type == Native.Keyboard && character.Value.Keyboard.Key == 0 && character.Value.Keyboard.Scan == '\u4E2D' && character.Value.Keyboard.Flags == Native.Unicode, "Unicode input ABI");
            string original = "Chinese \u4E2D\u6587\r\nemoji \uD83D\uDE00\tend";
            JavaScriptSerializer json = new JavaScriptSerializer(); Dictionary<string, object> decoded = json.Deserialize<Dictionary<string, object>>(json.Serialize(new { cmd = "text", text = original, modifiers = new string[] { "ctrl", "shift" } }));
            Check(Values.Text(decoded, "text", "") == original && Values.Modifiers(decoded).Count == 2, "Unicode JSONL roundtrip and modifiers");
            InputController.SelfTest();
            Console.Error.WriteLine("Windows native self-tests passed (ABI, coordinates, config bounds, key mappings, Unicode protocol, input cancellation, bounded release queue, rejected-up recovery and failed-move click prevention; no capture/input injection).");
        }
        private static void Command(IDictionary<string, object> command, Capture capture, InputController input, PacketOutput output) {
            string cmd = Values.Text(command, "cmd", "");
            if (cmd != "status") InputDebug.Trace("received cmd=" + cmd);
            switch (cmd) {
                case "move": case "down": case "up": case "drag": case "click": case "wheel": input.Submit(command, true); return;
                case "key": case "text": input.Submit(command, false); return;
                case "releaseInputs": input.Release(true, command); return;
                case "releasePointers": input.Release(false, command); return;
                case "status": capture.Status(); return;
                case "config": capture.Config(command); capture.Status(); return;
                case "promptScreen": case "promptAccessibility": capture.Status(); return;
                default: output.Json(new { type = "error", message = "Unknown native command." }); return;
            }
        }
        private static void ReadCommands(Capture capture, InputController input, PacketOutput output) {
            JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = 65536;
            UTF8Encoding utf8 = new UTF8Encoding(false, true);
            using (Stream stream = Console.OpenStandardInput()) using (MemoryStream line = new MemoryStream()) {
                byte[] buffer = new byte[4096]; bool dropping = false;
                while (!stopping) {
                    int count = stream.Read(buffer, 0, buffer.Length); if (count == 0) break;
                    for (int i = 0; i < count; i++) {
                        if (buffer[i] == 10) {
                            if (!dropping && line.Length > 0) {
                                try { Dictionary<string, object> command = json.Deserialize<Dictionary<string, object>>(utf8.GetString(line.ToArray())); if (command == null) throw new ArgumentException(); Command(command, capture, input, output); }
                                catch (Exception) { output.Json(new { type = "error", message = "Invalid native command JSON." }); }
                            }
                            line.SetLength(0); dropping = false;
                        } else if (!dropping) {
                            if (line.Length >= 65536) { output.Json(new { type = "error", message = "Native command line exceeds 65536 bytes." }); line.SetLength(0); dropping = true; }
                            else line.WriteByte(buffer[i]);
                        }
                    }
                }
            }
        }
        [STAThread] private static int Main(string[] args) {
            try {
                if (args.Length > 0 && args[0] == "--self-test") { InputDebug.Suppress = true; SelfTest(); return 0; }
                Native.SetDpi(); Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; RequestStop(); };
                using (PacketOutput output = new PacketOutput()) using (Capture capture = new Capture(output)) using (InputController input = new InputController(capture, output)) {
                    capture.Status(); ReadCommands(capture, input, output);
                }
                return 0;
            } catch (Exception exception) { Console.Error.WriteLine("Windows native worker failed: " + exception.Message); return 1; }
        }
    }
}
