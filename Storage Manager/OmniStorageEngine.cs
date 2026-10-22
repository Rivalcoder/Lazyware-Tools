using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace OmniStorage
{
    class Program
    {
        private const int PORT = 4455;
        private static string BasePublicDir;
        private static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 100 * 1024 * 1024 };

        // Cache for tree scans & dev artifacts
        private static ConcurrentDictionary<string, ScanCacheEntry> ScanCache = new ConcurrentDictionary<string, ScanCacheEntry>();
        private static object DevArtifactsLock = new object();
        private static Dictionary<string, object> DevArtifactsCache = null;
        private static DateTime DevArtifactsCacheTime = DateTime.MinValue;
        private static bool IsScanningDev = false;

        private static Dictionary<string, object> CleanupAuditCache = null;
        private static DateTime CleanupAuditCacheTime = DateTime.MinValue;

        private class ScanCacheEntry
        {
            public Dictionary<string, object> Data;
            public DateTime CreatedAt;
        }

        #region Win32 P/Invoke
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public class MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
            public MEMORYSTATUSEX() { dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)); }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        public struct SHQUERYRBINFO
        {
            public int cbSize;
            public long i64Size;
            public long i64NumItems;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHQueryRecycleBin(string pszRootPath, ref SHQUERYRBINFO pSHQueryRBInfo);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint dwFlags);
        #endregion

        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            string currentDir = AppDomain.CurrentDomain.BaseDirectory;
            BasePublicDir = Path.Combine(currentDir, "public");
            if (!Directory.Exists(BasePublicDir))
            {
                BasePublicDir = Path.Combine(Directory.GetCurrentDirectory(), "public");
            }

            Console.WriteLine("========================================================");
            Console.WriteLine("  OmniStorage Pro - Native High-Speed C# Backend Engine ");
            Console.WriteLine("========================================================");
            Console.WriteLine("Public Web Root: " + BasePublicDir);

            // Pre-warm caches in background thread
            Task.Run(() => WarmCaches());

            StartHttpServer();
        }

        private static void StartHttpServer()
        {
            HttpListener listener = new HttpListener();
            string prefix = string.Format("http://localhost:{0}/", PORT);
            string prefixIp = string.Format("http://127.0.0.1:{0}/", PORT);
            listener.Prefixes.Add(prefix);
            listener.Prefixes.Add(prefixIp);

            try
            {
                listener.Start();
                Console.WriteLine(string.Format("🚀 OmniStorage Native Engine running at: {0}", prefix));
            }
            catch (Exception ex)
            {
                Console.WriteLine("FATAL: Failed to bind HttpListener: " + ex.Message);
                return;
            }

            // Loop to handle requests asynchronously
            while (listener.IsListening)
            {
                try
                {
                    HttpListenerContext context = listener.GetContext();
                    ThreadPool.QueueUserWorkItem((ctx) =>
                    {
                        ProcessRequest((HttpListenerContext)ctx);
                    }, context);
                }
                catch (Exception)
                {
                    if (!listener.IsListening) break;
                }
            }
        }

        private static void ProcessRequest(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;

            // CORS headers
            response.AddHeader("Access-Control-Allow-Origin", "*");
            response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            response.AddHeader("Access-Control-Allow-Headers", "Content-Type");

            if (request.HttpMethod == "OPTIONS")
            {
                response.StatusCode = 204;
                response.Close();
                return;
            }

            string rawUrl = request.RawUrl;
            string path = request.Url.AbsolutePath;

            try
            {
                if (path.StartsWith("/api/"))
                {
                    HandleApi(path, request, response);
                }
                else
                {
                    ServeStaticFile(path, request, response);
                }
            }
            catch (Exception ex)
            {
                SendJson(response, new Dictionary<string, object> {
                    { "success", false },
                    { "error", ex.Message }
                }, 500);
            }
        }

        #region Static File Handling
        private static void ServeStaticFile(string urlPath, HttpListenerRequest request, HttpListenerResponse response)
        {
            if (urlPath == "/" || string.IsNullOrEmpty(urlPath))
            {
                urlPath = "/index.html";
            }

            string safePath = urlPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
            string fullPath = Path.Combine(BasePublicDir, safePath);

            if (!File.Exists(fullPath))
            {
                response.StatusCode = 404;
                if (request.HttpMethod != "HEAD")
                {
                    byte[] notFound = Encoding.UTF8.GetBytes("404 Not Found");
                    response.ContentType = "text/plain";
                    response.OutputStream.Write(notFound, 0, notFound.Length);
                }
                response.Close();
                return;
            }

            string ext = Path.GetExtension(fullPath).ToLower();
            string mime = "application/octet-stream";
            switch (ext)
            {
                case ".html": mime = "text/html; charset=utf-8"; break;
                case ".css": mime = "text/css; charset=utf-8"; break;
                case ".js": mime = "application/javascript; charset=utf-8"; break;
                case ".json": mime = "application/json; charset=utf-8"; break;
                case ".svg": mime = "image/svg+xml"; break;
                case ".png": mime = "image/png"; break;
                case ".jpg":
                case ".jpeg": mime = "image/jpeg"; break;
                case ".ico": mime = "image/x-icon"; break;
                case ".woff":
                case ".woff2": mime = "font/woff2"; break;
            }

            response.ContentType = mime;
            response.AddHeader("Cache-Control", "no-cache");

            var fi = new FileInfo(fullPath);
            response.ContentLength64 = fi.Length;
            if (request.HttpMethod != "HEAD")
            {
                byte[] fileBytes = File.ReadAllBytes(fullPath);
                response.OutputStream.Write(fileBytes, 0, fileBytes.Length);
            }
            response.Close();
        }
        #endregion

        #region API Dispatcher
        private static void HandleApi(string path, HttpListenerRequest request, HttpListenerResponse response)
        {
            switch (path)
            {
                case "/api/system-overview":
                    GetSystemOverview(response);
                    break;

                case "/api/drives":
                    GetDrives(response);
                    break;

                case "/api/cleanup-audit":
                    GetCleanupAudit(response);
                    break;

                case "/api/dev-artifacts":
                    GetDevArtifacts(response);
                    break;

                case "/api/scan":
                    GetScan(request, response);
                    break;

                case "/api/clean-artifacts":
                    CleanArtifacts(request, response);
                    break;

                case "/api/clean":
                    CleanJunk(request, response);
                    break;

                case "/api/open-explorer":
                    OpenExplorer(request, response);
                    break;

                case "/api/open-storage-sense":
                    OpenStorageSense(response);
                    break;

                default:
                    SendJson(response, new Dictionary<string, object> {
                        { "success", false },
                        { "error", "API route not found: " + path }
                    }, 404);
                    break;
            }
        }
        #endregion

        #region Helper Utilities
        private static string FormatBytes(long bytes)
        {
            if (bytes <= 0) return "0 B";
            string[] sizes = { "B", "KB", "MB", "GB", "TB" };
            double len = bytes;
            int order = 0;
            while (len >= 1024 && order < sizes.Length - 1)
            {
                order++;
                len /= 1024;
            }
            return string.Format("{0:0.##} {1}", len, sizes[order]);
        }

        private static void SendJson(HttpListenerResponse response, object data, int statusCode = 200)
        {
            try
            {
                response.StatusCode = statusCode;
                response.ContentType = "application/json; charset=utf-8";
                string jsonString = Json.Serialize(data);
                byte[] buffer = Encoding.UTF8.GetBytes(jsonString);
                response.ContentLength64 = buffer.Length;
                response.OutputStream.Write(buffer, 0, buffer.Length);
            }
            catch {}
            finally
            {
                try { response.Close(); } catch {}
            }
        }

        private static Dictionary<string, object> ReadJsonBody(HttpListenerRequest request)
        {
            using (var reader = new StreamReader(request.InputStream, request.ContentEncoding))
            {
                string text = reader.ReadToEnd();
                if (string.IsNullOrEmpty(text)) return new Dictionary<string, object>();
                return Json.Deserialize<Dictionary<string, object>>(text);
            }
        }

        private static void Categorize(string fullPath, bool isDir, out string category, out string safety, out string color)
        {
            string lower = fullPath.ToLower();
            string ext = Path.GetExtension(lower);
            string name = Path.GetFileName(lower);

            if (lower.Contains(@"\windows") || lower.Contains(@"\system32") || lower.Contains("pagefile.sys") || lower.Contains("hiberfil.sys") || lower.Contains(@"\program files"))
            {
                safety = "protected";
                category = "system";
                color = "#ef4444";
                return;
            }

            if (lower.Contains("node_modules") || lower.Contains(@"\.next") || lower.Contains(@"\dist") || lower.Contains(@"\build") || lower.Contains(@"\.gradle") || lower.Contains(@"\temp\") || lower.Contains(@"\cache\"))
            {
                safety = "safe";
            }
            else
            {
                safety = "review";
            }

            if (name == "node_modules" || lower.Contains(@"\node_modules"))
            {
                category = "dev";
                color = "#eab308";
            }
            else if (lower.Contains("mobile builds") || name == ".gradle" || name == ".dart_tool")
            {
                category = "dev";
                color = "#f97316";
            }
            else if (ext == ".mp4" || ext == ".mkv" || ext == ".mov" || ext == ".avi" || ext == ".mp3" || ext == ".wav" || ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".gif" || ext == ".webp")
            {
                category = "media";
                color = "#8b5cf6";
            }
            else if (ext == ".zip" || ext == ".rar" || ext == ".7z" || ext == ".tar" || ext == ".gz")
            {
                category = "archives";
                color = "#ec4899";
            }
            else if (ext == ".exe" || ext == ".msi" || ext == ".dll")
            {
                category = "apps";
                color = "#3b82f6";
            }
            else if (ext == ".js" || ext == ".ts" || ext == ".jsx" || ext == ".tsx" || ext == ".py" || ext == ".java" || ext == ".cs" || ext == ".cpp" || ext == ".c" || ext == ".json" || ext == ".html" || ext == ".css")
            {
                category = "code";
                color = "#10b981";
            }
            else if (ext == ".pdf" || ext == ".docx" || ext == ".xlsx" || ext == ".pptx" || ext == ".csv" || ext == ".txt")
            {
                category = "documents";
                color = "#06b6d4";
            }
            else
            {
                category = isDir ? "folders" : "other";
                color = "#64748b";
            }
        }
        #endregion

        #region Endpoints Implementation

        // 1. /api/system-overview
        private static void GetSystemOverview(HttpListenerResponse response)
        {
            var mem = new MEMORYSTATUSEX();
            GlobalMemoryStatusEx(mem);

            var drivesList = QueryDrivesList();
            long totalAllBytes = 0;
            long freeAllBytes = 0;

            foreach (var d in drivesList)
            {
                totalAllBytes += (long)d["totalBytes"];
                freeAllBytes += (long)d["freeBytes"];
            }
            long usedAllBytes = totalAllBytes - freeAllBytes;
            int usedPct = totalAllBytes > 0 ? (int)Math.Round((double)usedAllBytes / totalAllBytes * 100) : 0;

            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var userFolders = new Dictionary<string, string>
            {
                { "home", home },
                { "downloads", Path.Combine(home, "Downloads") },
                { "documents", Path.Combine(home, "Documents") },
                { "desktop", Path.Combine(home, "Desktop") },
                { "temp", Path.GetTempPath() },
                { "codeStuffs", @"C:\CodeStuffs" }
            };

            var data = new Dictionary<string, object>
            {
                { "success", true },
                { "hostname", Environment.MachineName },
                { "platform", string.Format("Microsoft Windows {0} ({1})", Environment.OSVersion.Version, Environment.Is64BitOperatingSystem ? "64-bit" : "32-bit") },
                { "uptimeHours", (TimeSpan.FromMilliseconds(Environment.TickCount).TotalHours).ToString("0.0") },
                { "totalRam", FormatBytes((long)mem.ullTotalPhys) },
                { "freeRam", FormatBytes((long)mem.ullAvailPhys) },
                { "ramLoadPercent", mem.dwMemoryLoad },
                { "drives", drivesList },
                { "userFolders", userFolders },
                { "totalStorage", new Dictionary<string, object> {
                    { "totalBytes", totalAllBytes },
                    { "freeBytes", freeAllBytes },
                    { "usedBytes", usedAllBytes },
                    { "totalFormatted", FormatBytes(totalAllBytes) },
                    { "freeFormatted", FormatBytes(freeAllBytes) },
                    { "usedFormatted", FormatBytes(usedAllBytes) },
                    { "usedPct", usedPct }
                }}
            };

            SendJson(response, data);
        }

        // 2. /api/drives
        private static void GetDrives(HttpListenerResponse response)
        {
            var drives = QueryDrivesList();
            SendJson(response, new Dictionary<string, object> {
                { "success", true },
                { "drives", drives }
            });
        }

        private static List<Dictionary<string, object>> QueryDrivesList()
        {
            var list = new List<Dictionary<string, object>>();
            DriveInfo[] drives = DriveInfo.GetDrives();

            foreach (var d in drives)
            {
                if (!d.IsReady) continue;
                string driveLetter = d.Name.TrimEnd('\\');
                string name = !string.IsNullOrEmpty(d.VolumeLabel) ? d.VolumeLabel : (d.DriveType == DriveType.Fixed ? "Local Disk" : d.DriveType.ToString());
                long total = d.TotalSize;
                long free = d.TotalFreeSpace;
                long used = total - free;
                int pct = total > 0 ? (int)Math.Round((double)used / total * 100) : 0;
                bool isSys = d.Name.StartsWith("C:", StringComparison.OrdinalIgnoreCase);

                list.Add(new Dictionary<string, object> {
                    { "id", driveLetter },
                    { "name", name },
                    { "path", d.Name },
                    { "fileSystem", d.DriveFormat },
                    { "type", d.DriveType.ToString() },
                    { "isSystem", isSys },
                    { "totalBytes", total },
                    { "freeBytes", free },
                    { "usedBytes", used },
                    { "totalFormatted", FormatBytes(total) },
                    { "freeFormatted", FormatBytes(free) },
                    { "usedFormatted", FormatBytes(used) },
                    { "usedPercentage", pct }
                });
            }
            return list;
        }

        // 3. /api/cleanup-audit
        private static void GetCleanupAudit(HttpListenerResponse response)
        {
            if (CleanupAuditCache != null && (DateTime.UtcNow - CleanupAuditCacheTime).TotalMinutes < 3)
            {
                SendJson(response, new Dictionary<string, object> {
                    { "success", true },
                    { "audit", CleanupAuditCache }
                });
                return;
            }

            var audit = RunAudit();
            CleanupAuditCache = audit;
            CleanupAuditCacheTime = DateTime.UtcNow;

            SendJson(response, new Dictionary<string, object> {
                { "success", true },
                { "audit", audit }
            });
        }

        private static Dictionary<string, object> RunAudit()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

            var safeTargets = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> { { "key", "userTemp" }, { "name", "User Temporary Files" }, { "description", "Temporary session cache and application scratch files safely removable." }, { "path", Path.GetTempPath() }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "recycleBin" }, { "name", "Windows Recycle Bin" }, { "description", "Deleted files occupying drive storage pending permanent clearance." }, { "path", @"$Recycle.Bin" }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "systemTemp" }, { "name", "Windows System Temp" }, { "description", "Operating system temporary scratch files and install logs." }, { "path", @"C:\Windows\Temp" }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "prefetch" }, { "name", "Windows Prefetch Cache" }, { "description", "Stale application launch history prefetch binaries." }, { "path", @"C:\Windows\Prefetch" }, { "badge", "SAFE TO PURGE" }, { "risk", "low" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "edgeCache" }, { "name", "Microsoft Edge Browser Cache" }, { "description", "Temporary web assets, downloaded script bundles, and offline media." }, { "path", Path.Combine(localApp, @"Microsoft\Edge\User Data\Default\Cache") }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "chromeCache" }, { "name", "Google Chrome Browser Cache" }, { "description", "Cached web pages, stylesheets, images, and streaming buffer chunks." }, { "path", Path.Combine(localApp, @"Google\Chrome\User Data\Default\Cache") }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "crashDumps" }, { "name", "Windows Error Crash Dumps" }, { "description", "Memory dumps recorded when applications previously crashed." }, { "path", Path.Combine(localApp, "CrashDumps") }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "npmCache" }, { "name", "Node.js NPM Package Cache" }, { "description", "Tarballs of downloaded NPM packages stored locally." }, { "path", Path.Combine(localApp, "npm-cache") }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "pipCache" }, { "name", "Python Pip Download Cache" }, { "description", "Cached Python wheel distributions and egg packages." }, { "path", Path.Combine(localApp, @"pip\cache") }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "thumbnails" }, { "name", "Windows Thumbnail Cache" }, { "description", "Icon and media preview databases (automatically rebuilt)." }, { "path", Path.Combine(localApp, @"Microsoft\Windows\Explorer") }, { "badge", "SAFE TO PURGE" }, { "risk", "low" }, { "checked", true } },
                new Dictionary<string, object> { { "key", "deliveryOpt" }, { "name", "Windows Delivery Optimization" }, { "description", "P2P peer download cache for Windows Store and updates." }, { "path", @"C:\Windows\SoftwareDistribution\DeliveryOptimization" }, { "badge", "SAFE TO PURGE" }, { "risk", "none" }, { "checked", true } }
            };

            // Measure safe targets in parallel
            Parallel.ForEach(safeTargets, target =>
            {
                string key = (string)target["key"];
                string path = (string)target["path"];
                long size = 0;
                long files = 0;

                if (key == "recycleBin")
                {
                    var rb = new SHQUERYRBINFO();
                    rb.cbSize = Marshal.SizeOf(typeof(SHQUERYRBINFO));
                    if (SHQueryRecycleBin(@"C:\", ref rb) == 0)
                    {
                        size = rb.i64Size;
                        files = rb.i64NumItems;
                    }
                }
                else
                {
                    if (Directory.Exists(path))
                    {
                        try
                        {
                            var di = new DirectoryInfo(path);
                            foreach (var fi in di.EnumerateFiles("*", SearchOption.AllDirectories))
                            {
                                size += fi.Length;
                                files++;
                            }
                        }
                        catch {}
                    }
                }

                target["sizeBytes"] = size;
                target["sizeFormatted"] = FormatBytes(size);
                target["fileCount"] = files;
                target["exists"] = size > 0 || Directory.Exists(path);
            });

            long totalSafeBytes = 0;
            foreach (var t in safeTargets)
            {
                totalSafeBytes += (long)t["sizeBytes"];
            }

            // Review targets (Downloads)
            string downloadsPath = Path.Combine(home, "Downloads");
            long dlSize = 0;
            long dlFiles = 0;
            if (Directory.Exists(downloadsPath))
            {
                try
                {
                    var di = new DirectoryInfo(downloadsPath);
                    foreach (var fi in di.EnumerateFiles("*", SearchOption.AllDirectories))
                    {
                        dlSize += fi.Length;
                        dlFiles++;
                    }
                }
                catch {}
            }

            var reviewTargets = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> {
                    { "key", "downloads" },
                    { "name", "Personal Downloads Folder" },
                    { "description", "Files, installers, and documents downloaded from browsers." },
                    { "path", downloadsPath },
                    { "badge", "User Review" },
                    { "risk", "medium" },
                    { "sizeBytes", dlSize },
                    { "sizeFormatted", FormatBytes(dlSize) },
                    { "fileCount", dlFiles },
                    { "checked", false },
                    { "exists", Directory.Exists(downloadsPath) }
                }
            };

            // Protected targets
            var protectedTargets = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> {
                    { "key", "winCore" }, { "name", "Windows System Files & Drivers" },
                    { "description", "Critical operating system binaries, DLLs, and kernel drivers essential for booting Windows." },
                    { "path", @"C:\Windows\System32" }, { "badge", "PROTECTED - DO NOT DELETE" }, { "risk", "critical" },
                    { "isProtected", true }, { "reason", "Deleting or modifying these files will corrupt Windows and cause BSOD." },
                    { "sizeFormatted", "System Managed" }, { "sizeBytes", 18L * 1024 * 1024 * 1024 }
                },
                new Dictionary<string, object> {
                    { "key", "winSxS" }, { "name", "Windows Component Store (WinSxS)" },
                    { "description", "Servicing components and previous versions for rollbacks and updates." },
                    { "path", @"C:\Windows\WinSxS" }, { "badge", "PROTECTED - SYSTEM STORE" }, { "risk", "critical" },
                    { "isProtected", true }, { "reason", "Hard-linked system files managed exclusively by DISM." },
                    { "sizeFormatted", "System Managed" }, { "sizeBytes", 12L * 1024 * 1024 * 1024 }
                },
                new Dictionary<string, object> {
                    { "key", "pagefile" }, { "name", "Paging File (pagefile.sys)" },
                    { "description", "Virtual memory backup file used by Windows when RAM is heavily committed." },
                    { "path", @"C:\pagefile.sys" }, { "badge", "PROTECTED - VIRTUAL RAM" }, { "risk", "high" },
                    { "isProtected", true }, { "reason", "Windows locks this file at boot for memory paging." },
                    { "sizeFormatted", File.Exists(@"C:\pagefile.sys") ? FormatBytes(new FileInfo(@"C:\pagefile.sys").Length) : "System Managed" },
                    { "sizeBytes", File.Exists(@"C:\pagefile.sys") ? new FileInfo(@"C:\pagefile.sys").Length : 0 }
                },
                new Dictionary<string, object> {
                    { "key", "hiberfil" }, { "name", "Hibernation File (hiberfil.sys)" },
                    { "description", "Saves RAM state to disk for Fast Startup and Hibernation mode." },
                    { "path", @"C:\hiberfil.sys" }, { "badge", "PROTECTED - FAST STARTUP" }, { "risk", "high" },
                    { "isProtected", true }, { "reason", "Managed by powercfg /hibernate command." },
                    { "sizeFormatted", File.Exists(@"C:\hiberfil.sys") ? FormatBytes(new FileInfo(@"C:\hiberfil.sys").Length) : "System Managed" },
                    { "sizeBytes", File.Exists(@"C:\hiberfil.sys") ? new FileInfo(@"C:\hiberfil.sys").Length : 0 }
                },
                new Dictionary<string, object> {
                    { "key", "progFiles" }, { "name", "Program Files & Installed Applications" },
                    { "description", "Installed software, Microsoft Office, browsers, and application runtimes." },
                    { "path", @"C:\Program Files" }, { "badge", "MANAGED VIA UNINSTALLER" }, { "risk", "high" },
                    { "isProtected", true }, { "reason", "Uninstall cleanly through Windows Settings > Apps." },
                    { "sizeFormatted", "Application Managed" }, { "sizeBytes", 0 }
                }
            };

            return new Dictionary<string, object>
            {
                { "totalSafeBytes", totalSafeBytes },
                { "totalSafeFormatted", FormatBytes(totalSafeBytes) },
                { "totalReviewBytes", dlSize },
                { "totalReviewFormatted", FormatBytes(dlSize) },
                { "safe", safeTargets },
                { "review", reviewTargets },
                { "protected", protectedTargets }
            };
        }

        // 4. /api/dev-artifacts
        private static void GetDevArtifacts(HttpListenerResponse response)
        {
            lock (DevArtifactsLock)
            {
                if (DevArtifactsCache != null && (DateTime.UtcNow - DevArtifactsCacheTime).TotalMinutes < 3)
                {
                    SendJson(response, DevArtifactsCache);
                    return;
                }
            }

            var data = ScanAllDevArtifacts(new[] { @"C:\CodeStuffs" });
            lock (DevArtifactsLock)
            {
                DevArtifactsCache = data;
                DevArtifactsCacheTime = DateTime.UtcNow;
            }

            SendJson(response, data);
        }

        private static Dictionary<string, object> ScanAllDevArtifacts(string[] roots)
        {
            var artifacts = new ConcurrentBag<Dictionary<string, object>>();

            foreach (var root in roots)
            {
                if (!Directory.Exists(root)) continue;

                // Discover projects at depth 1-3
                try
                {
                    var subDirs = Directory.GetDirectories(root);
                    Parallel.ForEach(subDirs, dir =>
                    {
                        FindArtifactsRecursive(dir, 0, 4, artifacts);
                    });
                }
                catch {}
            }

            var list = new List<Dictionary<string, object>>(artifacts);
            list.Sort((a, b) => ((long)b["sizeBytes"]).CompareTo((long)a["sizeBytes"]));

            long sumModules = 0; int countModules = 0;
            long sumMobile = 0; int countMobile = 0;
            long sumWeb = 0; int countWeb = 0;
            long sumVenv = 0; int countVenv = 0;

            foreach (var item in list)
            {
                string cat = (string)item["category"];
                long sz = (long)item["sizeBytes"];
                if (cat == "node_modules") { sumModules += sz; countModules++; }
                else if (cat == "mobile_build") { sumMobile += sz; countMobile++; }
                else if (cat == "web_build") { sumWeb += sz; countWeb++; }
                else if (cat == "python_venv") { sumVenv += sz; countVenv++; }
            }

            long grandTotal = sumModules + sumMobile + sumWeb + sumVenv;

            var res = new Dictionary<string, object>
            {
                { "success", true },
                { "totalBytes", grandTotal },
                { "totalFormatted", FormatBytes(grandTotal) },
                { "totalArtifacts", list.Count },
                { "summary", new Dictionary<string, object> {
                    { "nodeModules", new Dictionary<string, object> { { "bytes", sumModules }, { "formatted", FormatBytes(sumModules) }, { "count", countModules } } },
                    { "mobileBuilds", new Dictionary<string, object> { { "bytes", sumMobile }, { "formatted", FormatBytes(sumMobile) }, { "count", countMobile } } },
                    { "webBuilds", new Dictionary<string, object> { { "bytes", sumWeb }, { "formatted", FormatBytes(sumWeb) }, { "count", countWeb } } },
                    { "pythonVenvs", new Dictionary<string, object> { { "bytes", sumVenv }, { "formatted", FormatBytes(sumVenv) }, { "count", countVenv } } }
                }},
                { "artifacts", list }
            };

            return res;
        }

        private static void FindArtifactsRecursive(string dir, int depth, int maxDepth, ConcurrentBag<Dictionary<string, object>> artifacts)
        {
            if (depth > maxDepth || !Directory.Exists(dir)) return;

            string name = Path.GetFileName(dir);
            string nameLower = name.ToLower();
            string fullLower = dir.ToLower();

            if (nameLower == ".git" || nameLower == "$recycle.bin" || nameLower == "appdata") return;

            bool isNodeModules = nameLower == "node_modules";
            bool isMobile = nameLower == "build" && (fullLower.Contains("mobile") || fullLower.Contains("android") || fullLower.Contains("app")) ||
                            nameLower == ".gradle" || nameLower == ".dart_tool" || nameLower == "pods" || fullLower.Contains(@"mobile builds\");
            bool isWeb = nameLower == ".next" || nameLower == "dist" || nameLower == "out" || (nameLower == "build" && !isMobile);
            bool isVenv = nameLower == "venv" || nameLower == ".venv" || nameLower == "env" || nameLower == "__pycache__";

            if (isNodeModules || isMobile || isWeb || isVenv)
            {
                string cat = "web_build";
                string typeLabel = "Web Build (.next / dist)";
                if (isNodeModules) { cat = "node_modules"; typeLabel = "node_modules"; }
                else if (isVenv) { cat = "python_venv"; typeLabel = "Python Virtualenv"; }
                else if (isMobile) { cat = "mobile_build"; typeLabel = "Mobile / Android Build"; }

                long size = 0;
                long fileCount = 0;
                try
                {
                    var di = new DirectoryInfo(dir);
                    foreach (var fi in di.EnumerateFiles("*", SearchOption.AllDirectories))
                    {
                        size += fi.Length;
                        fileCount++;
                    }
                }
                catch {}

                string projName = Path.GetFileName(Path.GetDirectoryName(dir));
                if (string.IsNullOrEmpty(projName)) projName = "Workspace";

                artifacts.Add(new Dictionary<string, object> {
                    { "name", name },
                    { "path", dir },
                    { "projectName", projName },
                    { "category", cat },
                    { "typeLabel", typeLabel },
                    { "sizeBytes", size },
                    { "sizeFormatted", FormatBytes(size) },
                    { "fileCount", fileCount },
                    { "modified", Directory.GetLastWriteTime(dir).ToString("o") }
                });

                return; // Do not recurse into artifact internals
            }

            try
            {
                foreach (var sub in Directory.GetDirectories(dir))
                {
                    FindArtifactsRecursive(sub, depth + 1, maxDepth, artifacts);
                }
            }
            catch {}
        }

        // 5. /api/scan?path=...&depth=2&includeSystem=true
        private static void GetScan(HttpListenerRequest request, HttpListenerResponse response)
        {
            string targetPath = request.QueryString["path"];
            if (string.IsNullOrEmpty(targetPath))
            {
                targetPath = @"C:\CodeStuffs";
                if (!Directory.Exists(targetPath)) targetPath = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }

            int depth = 2;
            int.TryParse(request.QueryString["depth"], out depth);
            if (depth <= 0) depth = 2;

            bool includeSystem = true;
            if (!string.IsNullOrEmpty(request.QueryString["includeSystem"]))
            {
                bool.TryParse(request.QueryString["includeSystem"], out includeSystem);
            }

            string cacheKey = string.Format("{0}_d{1}_s{2}", targetPath.ToLower(), depth, includeSystem);
            ScanCacheEntry cached;
            if (ScanCache.TryGetValue(cacheKey, out cached))
            {
                if ((DateTime.UtcNow - cached.CreatedAt).TotalSeconds < 90)
                {
                    SendJson(response, cached.Data);
                    return;
                }
            }

            var largestFiles = new ConcurrentBag<Dictionary<string, object>>();
            var tree = ScanDirectoryTree(targetPath, depth, 0, largestFiles, includeSystem);

            var largestList = new List<Dictionary<string, object>>(largestFiles);
            largestList.Sort((a, b) => ((long)b["size"]).CompareTo((long)a["size"]));
            if (largestList.Count > 50) largestList = largestList.GetRange(0, 50);

            var responseData = new Dictionary<string, object>
            {
                { "success", true },
                { "scanPath", targetPath },
                { "tree", tree },
                { "largestFiles", largestList },
                { "scannedAt", DateTime.UtcNow.ToString("o") }
            };

            ScanCache[cacheKey] = new ScanCacheEntry { Data = responseData, CreatedAt = DateTime.UtcNow };
            SendJson(response, responseData);
        }

        private static Dictionary<string, object> ScanDirectoryTree(string dirPath, int maxDepth, int currentDepth, ConcurrentBag<Dictionary<string, object>> largestFiles, bool includeSystem)
        {
            string dirName = Path.GetFileName(dirPath);
            if (string.IsNullOrEmpty(dirName)) dirName = dirPath;

            string cat, safety, col;
            Categorize(dirPath, true, out cat, out safety, out col);

            if (!includeSystem && safety == "protected" && currentDepth > 0) return null;

            long totalSize = 0;
            long fileCount = 0;
            var children = new List<Dictionary<string, object>>();

            if (!Directory.Exists(dirPath))
            {
                return new Dictionary<string, object> {
                    { "name", dirName }, { "path", dirPath }, { "size", 0 }, { "fileCount", 0 },
                    { "type", "directory" }, { "category", cat }, { "safety", safety }, { "color", col },
                    { "children", children }
                };
            }

            try
            {
                var dirInfo = new DirectoryInfo(dirPath);

                // 1. Files in current folder
                foreach (var fi in dirInfo.EnumerateFiles())
                {
                    totalSize += fi.Length;
                    fileCount++;

                    string fCat, fSafety, fCol;
                    Categorize(fi.FullName, false, out fCat, out fSafety, out fCol);

                    var fNode = new Dictionary<string, object> {
                        { "name", fi.Name },
                        { "path", fi.FullName },
                        { "size", fi.Length },
                        { "formattedSize", FormatBytes(fi.Length) },
                        { "fileCount", 1 },
                        { "type", "file" },
                        { "extension", fi.Extension.ToLower() },
                        { "category", fCat },
                        { "safety", fSafety },
                        { "color", fCol }
                    };

                    children.Add(fNode);
                    largestFiles.Add(fNode);
                }

                // 2. Subdirectories
                var subDirs = dirInfo.GetDirectories();

                if (currentDepth < maxDepth)
                {
                    // Parallelize top levels
                    if (currentDepth <= 1 && subDirs.Length > 2)
                    {
                        var childBag = new ConcurrentBag<Dictionary<string, object>>();
                        Parallel.ForEach(subDirs, sub =>
                        {
                            string sName = sub.Name.ToLower();
                            if (sName == "$recycle.bin" || sName == "system volume information") return;

                            var subNode = ScanDirectoryTree(sub.FullName, maxDepth, currentDepth + 1, largestFiles, includeSystem);
                            if (subNode != null) childBag.Add(subNode);
                        });
                        children.AddRange(childBag);
                    }
                    else
                    {
                        foreach (var sub in subDirs)
                        {
                            string sName = sub.Name.ToLower();
                            if (sName == "$recycle.bin" || sName == "system volume information") continue;

                            var subNode = ScanDirectoryTree(sub.FullName, maxDepth, currentDepth + 1, largestFiles, includeSystem);
                            if (subNode != null) children.Add(subNode);
                        }
                    }
                }
                else
                {
                    // Leaf depth: Fast parallel measure children without drilling
                    var leafBag = new ConcurrentBag<Dictionary<string, object>>();
                    Parallel.ForEach(subDirs, sub =>
                    {
                        string sName = sub.Name.ToLower();
                        if (sName == "$recycle.bin" || sName == "system volume information") return;

                        long sSize = 0;
                        long sCount = 0;
                        try
                        {
                            foreach (var sfi in sub.EnumerateFiles("*", SearchOption.AllDirectories))
                            {
                                sSize += sfi.Length;
                                sCount++;
                            }
                        }
                        catch {}

                        string sCat, sSafety, sCol;
                        Categorize(sub.FullName, true, out sCat, out sSafety, out sCol);

                        leafBag.Add(new Dictionary<string, object> {
                            { "name", sub.Name },
                            { "path", sub.FullName },
                            { "size", sSize },
                            { "formattedSize", FormatBytes(sSize) },
                            { "fileCount", sCount },
                            { "type", "directory" },
                            { "category", sCat },
                            { "safety", sSafety },
                            { "color", sCol },
                            { "children", new List<object>() }
                        });
                    });
                    children.AddRange(leafBag);
                }

                // Tally children sizes
                foreach (var c in children)
                {
                    if (c.ContainsKey("size") && c["size"] is long)
                    {
                        totalSize += (long)c["size"];
                    }
                    if (c.ContainsKey("fileCount") && c["fileCount"] is long)
                    {
                        fileCount += (long)c["fileCount"];
                    }
                }
            }
            catch {}

            return new Dictionary<string, object> {
                { "name", dirName },
                { "path", dirPath },
                { "size", totalSize },
                { "formattedSize", FormatBytes(totalSize) },
                { "fileCount", fileCount },
                { "type", "directory" },
                { "category", cat },
                { "safety", safety },
                { "color", col },
                { "children", children }
            };
        }

        // 6. /api/clean-artifacts
        private static void CleanArtifacts(HttpListenerRequest request, HttpListenerResponse response)
        {
            var body = ReadJsonBody(request);
            if (!body.ContainsKey("paths") || !(body["paths"] is ArrayList))
            {
                SendJson(response, new Dictionary<string, object> { { "success", false }, { "error", "paths array required" } }, 400);
                return;
            }

            var paths = (ArrayList)body["paths"];
            long totalFreed = 0;
            int freedCount = 0;
            var results = new List<Dictionary<string, object>>();

            foreach (var pObj in paths)
            {
                string p = pObj.ToString();
                string norm = Path.GetFullPath(p);
                string lower = norm.ToLower();

                bool isSafe = (
                    lower.Contains("node_modules") ||
                    lower.Contains(@"\.next") ||
                    lower.Contains(@"\dist") ||
                    lower.Contains(@"\build") ||
                    lower.Contains(@"\.gradle") ||
                    lower.Contains(@"\.dart_tool") ||
                    lower.Contains(@"\pods") ||
                    lower.Contains(@"\venv") ||
                    lower.Contains(@"\.venv")
                ) && lower.StartsWith(@"c:\codestuffs");

                if (!isSafe)
                {
                    results.Add(new Dictionary<string, object> { { "path", norm }, { "success", false }, { "error", "Path not authorized for purge" } });
                    continue;
                }

                if (Directory.Exists(norm))
                {
                    try
                    {
                        long size = 0;
                        var di = new DirectoryInfo(norm);
                        foreach (var fi in di.EnumerateFiles("*", SearchOption.AllDirectories)) size += fi.Length;

                        Directory.Delete(norm, true);
                        totalFreed += size;
                        freedCount++;

                        results.Add(new Dictionary<string, object> {
                            { "path", norm },
                            { "success", true },
                            { "freedBytes", size },
                            { "freedFormatted", FormatBytes(size) }
                        });
                    }
                    catch (Exception ex)
                    {
                        results.Add(new Dictionary<string, object> { { "path", norm }, { "success", false }, { "error", ex.Message } });
                    }
                }
                else
                {
                    results.Add(new Dictionary<string, object> { { "path", norm }, { "success", false }, { "error", "Folder not found" } });
                }
            }

            // Invalidate caches
            lock (DevArtifactsLock) { DevArtifactsCache = null; }
            ScanCache.Clear();

            Task.Run(() => WarmCaches());

            SendJson(response, new Dictionary<string, object> {
                { "success", true },
                { "totalFreedBytes", totalFreed },
                { "totalFreedFormatted", FormatBytes(totalFreed) },
                { "freedCount", freedCount },
                { "results", results }
            });
        }

        // 7. /api/clean
        private static void CleanJunk(HttpListenerRequest request, HttpListenerResponse response)
        {
            var body = ReadJsonBody(request);
            if (!body.ContainsKey("targetKeys") || !(body["targetKeys"] is ArrayList))
            {
                SendJson(response, new Dictionary<string, object> { { "success", false }, { "error", "targetKeys array required" } }, 400);
                return;
            }

            var keys = (ArrayList)body["targetKeys"];
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            long grandTotalBytes = 0;
            long grandTotalFiles = 0;
            var results = new List<Dictionary<string, object>>();

            foreach (var kObj in keys)
            {
                string key = kObj.ToString();
                string targetPath = null;
                bool isRecycleBin = key == "recycleBin";

                if (key == "userTemp") targetPath = Path.GetTempPath();
                else if (key == "systemTemp") targetPath = @"C:\Windows\Temp";
                else if (key == "edgeCache") targetPath = Path.Combine(localApp, @"Microsoft\Edge\User Data\Default\Cache");
                else if (key == "chromeCache") targetPath = Path.Combine(localApp, @"Google\Chrome\User Data\Default\Cache");
                else if (key == "crashDumps") targetPath = Path.Combine(localApp, "CrashDumps");
                else if (key == "npmCache") targetPath = Path.Combine(localApp, "npm-cache");
                else if (key == "pipCache") targetPath = Path.Combine(localApp, @"pip\cache");

                if (isRecycleBin)
                {
                    try
                    {
                        SHEmptyRecycleBin(IntPtr.Zero, null, 7); // SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
                        results.Add(new Dictionary<string, object> { { "key", key }, { "success", true }, { "message", "Recycle bin emptied" } });
                    }
                    catch (Exception ex)
                    {
                        results.Add(new Dictionary<string, object> { { "key", key }, { "success", false }, { "error", ex.Message } });
                    }
                }
                else if (!string.IsNullOrEmpty(targetPath) && Directory.Exists(targetPath))
                {
                    long freedBytes = 0;
                    long freedFiles = 0;

                    try
                    {
                        var di = new DirectoryInfo(targetPath);
                        foreach (var fi in di.EnumerateFiles())
                        {
                            try
                            {
                                long sz = fi.Length;
                                fi.Delete();
                                freedBytes += sz;
                                freedFiles++;
                            }
                            catch {}
                        }

                        foreach (var sub in di.EnumerateDirectories())
                        {
                            try
                            {
                                sub.Delete(true);
                            }
                            catch {}
                        }
                    }
                    catch {}

                    grandTotalBytes += freedBytes;
                    grandTotalFiles += freedFiles;

                    results.Add(new Dictionary<string, object> {
                        { "key", key },
                        { "targetPath", targetPath },
                        { "success", true },
                        { "freedBytes", freedBytes },
                        { "freedFormatted", FormatBytes(freedBytes) },
                        { "freedFiles", freedFiles }
                    });
                }
            }

            CleanupAuditCache = null;
            Task.Run(() => WarmCaches());

            SendJson(response, new Dictionary<string, object> {
                { "success", true },
                { "totalFreedBytes", grandTotalBytes },
                { "totalFreedFormatted", FormatBytes(grandTotalBytes) },
                { "totalFreedFiles", grandTotalFiles },
                { "results", results }
            });
        }

        // 8. /api/open-explorer
        private static void OpenExplorer(HttpListenerRequest request, HttpListenerResponse response)
        {
            var body = ReadJsonBody(request);
            if (!body.ContainsKey("targetPath"))
            {
                SendJson(response, new Dictionary<string, object> { { "success", false }, { "error", "targetPath required" } }, 400);
                return;
            }

            string p = body["targetPath"].ToString();
            if (File.Exists(p))
            {
                Process.Start("explorer.exe", string.Format("/select,\"{0}\"", p));
                SendJson(response, new Dictionary<string, object> { { "success", true }, { "message", "Opened " + p } });
            }
            else if (Directory.Exists(p))
            {
                Process.Start("explorer.exe", string.Format("\"{0}\"", p));
                SendJson(response, new Dictionary<string, object> { { "success", true }, { "message", "Opened " + p } });
            }
            else
            {
                SendJson(response, new Dictionary<string, object> { { "success", false }, { "error", "Path does not exist" } }, 404);
            }
        }

        // 9. /api/open-storage-sense
        private static void OpenStorageSense(HttpListenerResponse response)
        {
            try
            {
                Process.Start("ms-settings:storagesense");
                SendJson(response, new Dictionary<string, object> { { "success", true }, { "message", "Launched Storage Sense" } });
            }
            catch
            {
                try
                {
                    Process.Start("cleanmgr.exe");
                    SendJson(response, new Dictionary<string, object> { { "success", true }, { "message", "Launched Disk Cleanup" } });
                }
                catch (Exception ex)
                {
                    SendJson(response, new Dictionary<string, object> { { "success", false }, { "error", ex.Message } }, 500);
                }
            }
        }
        #endregion

        private static void WarmCaches()
        {
            if (IsScanningDev) return;
            IsScanningDev = true;
            try
            {
                var audit = RunAudit();
                CleanupAuditCache = audit;
                CleanupAuditCacheTime = DateTime.UtcNow;
                Console.WriteLine(string.Format("[Engine Audit] Primed: {0} safe to clear.", audit["totalSafeFormatted"]));

                var devData = ScanAllDevArtifacts(new[] { @"C:\CodeStuffs" });
                lock (DevArtifactsLock)
                {
                    DevArtifactsCache = devData;
                    DevArtifactsCacheTime = DateTime.UtcNow;
                }
                Console.WriteLine(string.Format("[Engine Dev Hunter] Primed: {0} across {1} artifacts.", devData["totalFormatted"], devData["totalArtifacts"]));
            }
            catch (Exception ex)
            {
                Console.WriteLine("[Engine Warmer] Warning: " + ex.Message);
            }
            finally
            {
                IsScanningDev = false;
            }
        }
    }
}
