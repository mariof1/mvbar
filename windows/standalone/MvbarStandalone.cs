using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("MVBar Standalone")]
[assembly: AssemblyDescription("Self-contained MVBar host for Windows")]
[assembly: AssemblyCompany("MVBar")]
[assembly: AssemblyProduct("MVBar")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class Program
{
    private const string BuildId = "__MVBAR_BUILD_ID__";
    private const string PayloadMagic = "MVBARPK1";
    private static readonly Dictionary<string, Process> Services =
        new Dictionary<string, Process>(StringComparer.OrdinalIgnoreCase);
    private static readonly List<ServiceLog> Logs = new List<ServiceLog>();
    private static readonly object ShutdownSync = new object();
    private static readonly object LauncherLogSync = new object();
    private static IntPtr jobHandle = IntPtr.Zero;
    private static volatile bool shuttingDown;
    private static bool restartRequested;
    private static LauncherForm launcherForm;
    private static string homeRoot;
    private static string appRoot;
    private static string dataRoot;
    private static string logRoot;
    private static string pgDataRoot;
    private static string pgCtlPath;

    [STAThread]
    private static int Main()
    {
        int exitCode = 0;
        bool restartAfterExit = false;
        bool ownsMutex;
        using (var mutex = new Mutex(true, @"Local\MVBarStandalone", out ownsMutex))
        {
            if (!ownsMutex)
            {
                OpenExistingInstance();
                return 0;
            }

            try
            {
                AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };
                if (Environment.GetEnvironmentVariable("MVBAR_HEADLESS") == "1")
                {
                    Run();
                }
                else
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (var form = new LauncherForm())
                    {
                        launcherForm = form;
                        Application.Run(form);
                        launcherForm = null;
                    }
                    restartAfterExit = restartRequested;
                }
            }
            catch (Exception error)
            {
                LogLauncher("FATAL", error.ToString());
                TryShowMessage("MVBar could not start.\r\n\r\n" + error.Message +
                    "\r\n\r\nSee the logs under:\r\n" + logRoot, "MVBar");
                Shutdown();
                exitCode = 1;
            }
        }

        if (restartAfterExit)
        {
            try
            {
                var startInfo = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location);
                startInfo.UseShellExecute = true;
                Process.Start(startInfo);
            }
            catch (Exception error)
            {
                LogLauncher("ERROR", "Could not restart MVBar: " + error);
                TryShowMessage(
                    "MVBar settings were saved, but Windows could not restart the app.\r\n\r\n" +
                        "Please open the standalone EXE again.",
                    "MVBar");
                exitCode = 1;
            }
        }
        return exitCode;
    }

    private static void Run()
    {
        if (!Environment.Is64BitOperatingSystem)
        {
            throw new InvalidOperationException("MVBar Standalone requires 64-bit Windows.");
        }

        homeRoot = Environment.GetEnvironmentVariable("MVBAR_HOME");
        if (String.IsNullOrWhiteSpace(homeRoot))
        {
            homeRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MVBar");
        }
        homeRoot = Path.GetFullPath(homeRoot);
        logRoot = Path.Combine(homeRoot, "logs");
        Directory.CreateDirectory(logRoot);
        ReportStatus("Preparing MVBar", "Checking the bundled application files...", 3);
        appRoot = EnsurePayloadExtracted();
        dataRoot = Path.Combine(homeRoot, "data");
        pgDataRoot = Path.Combine(dataRoot, "postgres");

        ReportStatus("Loading settings", "Preparing your local music library...", 18);
        CreateDataDirectories();
        var config = LoadOrCreateConfig();
        ConfigureEnvironment(config);
        CreateJob();

        int pgPort = FindFreePort(55432);
        int redisPort = FindFreePort(56379);
        int meiliPort = FindFreePort(57700);
        int apiPort = FindFreePort(53001);
        int webPort = FindFreePort(53000);
        int publicPort = FindAvailablePort(ParsePort(Get(config, "PORT", "8080"), 8080), 30);
        string listenHost = Get(config, "LISTEN_HOST", "127.0.0.1");

        string nodePath = AppPath("runtime", "node", "node.exe");
        string pgBin = AppPath("runtime", "postgres", "bin");
        string postgresPath = Path.Combine(pgBin, "postgres.exe");
        pgCtlPath = Path.Combine(pgBin, "pg_ctl.exe");
        string initDbPath = Path.Combine(pgBin, "initdb.exe");
        string psqlPath = Path.Combine(pgBin, "psql.exe");
        string createUserPath = Path.Combine(pgBin, "createuser.exe");
        string createDbPath = Path.Combine(pgBin, "createdb.exe");
        string garnetPath = AppPath("runtime", "garnet", "GarnetServer.exe");
        string meiliPath = AppPath("runtime", "meili", "meilisearch.exe");
        string ffmpegBin = AppPath("runtime", "ffmpeg");

        RequireFiles(new[]
        {
            nodePath, postgresPath, pgCtlPath, initDbPath, psqlPath,
            createUserPath, createDbPath, garnetPath, meiliPath,
            Path.Combine(ffmpegBin, "ffmpeg.exe"),
            Path.Combine(ffmpegBin, "ffprobe.exe"),
            AppPath("app", "api", "dist", "index.js"),
            AppPath("app", "worker", "dist", "index.js"),
            AppPath("app", "web", "server.js"),
            AppPath("app", "proxy.js")
        });

        Environment.SetEnvironmentVariable(
            "PATH",
            ffmpegBin + ";" + pgBin + ";" + Environment.GetEnvironmentVariable("PATH"));

        LogLauncher("INFO", "MVBar Standalone " + BuildId);
        LogLauncher("INFO", "Data: " + dataRoot);
        LogLauncher("INFO", "Logs: " + logRoot);

        ReportStatus("Starting database", "Preparing PostgreSQL...", 25);
        InitializePostgres(initDbPath);
        StartService("postgres", postgresPath,
            Args("-D", pgDataRoot, "-p", pgPort.ToString(), "-h", "127.0.0.1"),
            homeRoot, null);
        WaitForTcp("127.0.0.1", pgPort, 60);
        WaitForPostgres(psqlPath, pgPort, 90);
        ReportStatus("Starting database", "Applying MVBar database settings...", 36);
        PrepareDatabase(psqlPath, createUserPath, createDbPath, pgPort, config);

        var common = BuildCommonEnvironment(config, pgPort, redisPort, meiliPort);

        ReportStatus("Starting local services", "Starting the playback cache...", 44);
        string garnetData = Path.Combine(dataRoot, "garnet");
        StartService("garnet", garnetPath,
            Args(
                "--bind", "127.0.0.1",
                "--port", redisPort.ToString(),
                "--memory", "256m",
                "--index", "32m",
                "--checkpointdir", garnetData,
                "--aof",
                "--recover"),
            homeRoot, common);
        WaitForTcp("127.0.0.1", redisPort, 60);

        ReportStatus("Starting local services", "Starting music search...", 53);
        var meiliEnvironment = CopyEnvironment(common);
        meiliEnvironment["MEILI_HTTP_ADDR"] = "127.0.0.1:" + meiliPort;
        meiliEnvironment["MEILI_DB_PATH"] = Path.Combine(dataRoot, "meili");
        meiliEnvironment["MEILI_ENV"] = "production";
        meiliEnvironment["MEILI_NO_ANALYTICS"] = "true";
        StartService("meilisearch", meiliPath, "", homeRoot, meiliEnvironment);
        WaitForHttp("http://127.0.0.1:" + meiliPort + "/health", 120);

        ReportStatus("Starting MVBar", "Starting the application service...", 63);
        var apiEnvironment = CopyEnvironment(common);
        apiEnvironment["PORT"] = apiPort.ToString();
        apiEnvironment["HOST"] = "127.0.0.1";
        StartService("api", nodePath, "--experimental-global-webcrypto " + Args("dist/index.js"),
            AppPath("app", "api"), apiEnvironment);
        WaitForHttp("http://127.0.0.1:" + apiPort + "/health", 180);

        ReportStatus("Starting MVBar", "Starting the library scanner...", 72);
        StartService("worker", nodePath, Args("dist/index.js"),
            AppPath("app", "worker"), common);
        Thread.Sleep(1500);
        EnsureRunning("worker");

        ReportStatus("Starting MVBar", "Starting the web interface...", 81);
        var webEnvironment = CopyEnvironment(common);
        webEnvironment["PORT"] = webPort.ToString();
        webEnvironment["HOSTNAME"] = "127.0.0.1";
        webEnvironment["API_INTERNAL_BASE"] = "http://127.0.0.1:" + apiPort;
        StartService("web", nodePath, Args("server.js"),
            AppPath("app", "web"), webEnvironment);
        WaitForHttp("http://127.0.0.1:" + webPort + "/", 180);

        ReportStatus("Almost ready", "Opening the local MVBar gateway...", 91);
        var proxyEnvironment = CopyEnvironment(common);
        proxyEnvironment["MVBAR_PROXY_HOST"] = listenHost;
        proxyEnvironment["MVBAR_PROXY_PORT"] = publicPort.ToString();
        proxyEnvironment["MVBAR_API_PORT"] = apiPort.ToString();
        proxyEnvironment["MVBAR_WEB_PORT"] = webPort.ToString();
        StartService("proxy", nodePath, Args(AppPath("app", "proxy.js")),
            appRoot, proxyEnvironment);
        WaitForHttp("http://127.0.0.1:" + publicPort + "/health", 60);

        string url = "http://127.0.0.1:" + publicPort + "/";
        File.WriteAllText(Path.Combine(homeRoot, "runtime.url"), url, Encoding.UTF8);
        string administrator = Get(config, "ADMIN_EMAIL", "admin@local");
        string password = Get(config, "ADMIN_PASSWORD", "");
        string credentialsPath = Path.Combine(homeRoot, "credentials.txt");
        LogLauncher("INFO", "MVBar is ready: " + url);
        LogLauncher("INFO", "Administrator: " + administrator);
        ReportReady(
            url,
            administrator,
            password,
            credentialsPath,
            Get(config, "_FIRST_RUN", "0") == "1");

        if (Environment.GetEnvironmentVariable("MVBAR_HEADLESS") != "1")
        {
            OpenUrl(url);
        }
        MonitorServices();
    }

    private static void StartInteractive()
    {
        try
        {
            Run();
        }
        catch (Exception error)
        {
            if (shuttingDown)
            {
                return;
            }
            LogLauncher("FATAL", error.ToString());
            Shutdown();
            UpdateLauncher(delegate(LauncherForm form)
            {
                form.ShowFailure(
                    error.Message,
                    String.IsNullOrWhiteSpace(logRoot)
                        ? null
                        : Path.Combine(logRoot, "launcher.log"));
            });
        }
    }

    private static void ExitFromUi()
    {
        UpdateLauncher(delegate(LauncherForm form)
        {
            form.ShowStopping();
        });
        ThreadPool.QueueUserWorkItem(delegate
        {
            Shutdown();
            UpdateLauncher(delegate(LauncherForm form)
            {
                form.CompleteExit();
            });
        });
    }

    private static void RestartFromUi()
    {
        restartRequested = true;
        UpdateLauncher(delegate(LauncherForm form)
        {
            form.ShowRestarting();
        });
        ThreadPool.QueueUserWorkItem(delegate
        {
            Shutdown();
            UpdateLauncher(delegate(LauncherForm form)
            {
                form.CompleteExit();
            });
        });
    }

    private static void ReportStatus(string title, string detail, int progress)
    {
        LogLauncher("INFO", title + ": " + detail);
        UpdateLauncher(delegate(LauncherForm form)
        {
            form.SetStatus(title, detail, progress);
        });
    }

    private static void ReportExtractionProgress(int completed, int total)
    {
        if (total <= 0)
        {
            return;
        }
        int percent = Math.Max(3, Math.Min(17, 3 + (completed * 14 / total)));
        UpdateLauncher(delegate(LauncherForm form)
        {
            form.SetStatus(
                "Preparing MVBar",
                "Extracting local application files (" + completed + " of " + total + ")...",
                percent);
        });
    }

    private static void ReportReady(
        string url,
        string administrator,
        string password,
        string credentialsPath,
        bool firstRun)
    {
        UpdateLauncher(delegate(LauncherForm form)
        {
            form.ShowReady(url, administrator, password, credentialsPath, firstRun);
        });
    }

    private static void UpdateLauncher(Action<LauncherForm> action)
    {
        LauncherForm form = launcherForm;
        if (form != null)
        {
            form.Post(action);
        }
    }

    private static void LogLauncher(string level, string message)
    {
        try
        {
            string root = logRoot;
            if (String.IsNullOrWhiteSpace(root))
            {
                string configuredHome = Environment.GetEnvironmentVariable("MVBAR_HOME");
                if (String.IsNullOrWhiteSpace(configuredHome))
                {
                    configuredHome = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "MVBar");
                }
                root = Path.Combine(configuredHome, "logs");
            }
            Directory.CreateDirectory(root);
            lock (LauncherLogSync)
            {
                File.AppendAllText(
                    Path.Combine(root, "launcher.log"),
                    DateTime.Now.ToString("o") + " [" + level + "] " + message +
                        Environment.NewLine,
                    new UTF8Encoding(false));
            }
        }
        catch
        {
            // Logging must never prevent the launcher from starting or stopping.
        }
    }

    private static Dictionary<string, string> LoadOrCreateConfig()
    {
        string configPath = Path.Combine(homeRoot, "config.env");
        bool firstRun = !File.Exists(configPath);
        var config = firstRun
            ? CreateDefaultConfig()
            : ParseConfig(File.ReadAllLines(configPath, Encoding.UTF8));

        if (firstRun)
        {
            Directory.CreateDirectory(homeRoot);
            WriteConfig(configPath, config);
        }
        else
        {
            var additions = new List<string>();
            if (!config.ContainsKey("BACKUP_DIR") || String.IsNullOrWhiteSpace(config["BACKUP_DIR"]))
            {
                config["BACKUP_DIR"] = Path.Combine(dataRoot, "backups");
                additions.Add("BACKUP_DIR=" + config["BACKUP_DIR"]);
            }
            string[,] pluginDefaults =
            {
                { "PLUGINS_ENABLED", "true" },
                { "PLUGINS_DIR", Path.Combine(dataRoot, "plugins") },
                { "PLUGIN_MAX_UPLOAD_MB", "50" },
                { "PLUGIN_TIMEOUT_MS", "15000" },
                { "PLUGIN_MEMORY_MB", "64" },
                { "PLUGIN_MAX_CONCURRENCY", "4" }
            };
            for (int i = 0; i < pluginDefaults.GetLength(0); i++)
            {
                string key = pluginDefaults[i, 0];
                if (!config.ContainsKey(key) || String.IsNullOrWhiteSpace(config[key]))
                {
                    config[key] = pluginDefaults[i, 1];
                    additions.Add(key + "=" + config[key]);
                }
            }
            if (additions.Count > 0)
            {
                File.AppendAllText(
                    configPath,
                    Environment.NewLine + "# Server-managed backup and sandboxed plugins" + Environment.NewLine +
                        String.Join(Environment.NewLine, additions.ToArray()) + Environment.NewLine,
                    Encoding.UTF8);
            }
        }

        config["_FIRST_RUN"] = firstRun ? "1" : "0";
        string credentialsPath = Path.Combine(homeRoot, "credentials.txt");
        if (firstRun || !File.Exists(credentialsPath))
        {
            File.WriteAllText(
                credentialsPath,
                "MVBar Standalone administrator\r\n" +
                "Email: " + Get(config, "ADMIN_EMAIL", "admin@local") + "\r\n" +
                "Password: " + Get(config, "ADMIN_PASSWORD", "") + "\r\n",
                Encoding.UTF8);
        }
        return config;
    }

    private static Dictionary<string, string> CreateDefaultConfig()
    {
        string music = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);
        Directory.CreateDirectory(music);

        var config = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        config["ADMIN_EMAIL"] = "admin@local";
        config["ADMIN_PASSWORD"] = RandomText(22);
        config["DATABASE_PASSWORD"] = RandomText(28);
        config["JWT_SECRET"] = RandomHex(48);
        config["MEILI_MASTER_KEY"] = RandomHex(32);
        config["MUSIC_DIRS"] = music;
        config["AUDIOBOOK_DIRS"] = "";
        config["BACKUP_DIR"] = Path.Combine(dataRoot, "backups");
        config["PLUGINS_ENABLED"] = "true";
        config["PLUGINS_DIR"] = Path.Combine(dataRoot, "plugins");
        config["PLUGIN_MAX_UPLOAD_MB"] = "50";
        config["PLUGIN_TIMEOUT_MS"] = "15000";
        config["PLUGIN_MEMORY_MB"] = "64";
        config["PLUGIN_MAX_CONCURRENCY"] = "4";
        config["LISTEN_HOST"] = "127.0.0.1";
        config["PORT"] = "8080";
        return config;
    }

    private static void WriteConfig(string path, Dictionary<string, string> config)
    {
        var lines = new List<string>();
        lines.Add("# MVBar Standalone settings");
        lines.Add("# Multiple media folders are comma separated.");
        string[] keys =
        {
            "ADMIN_EMAIL", "ADMIN_PASSWORD", "DATABASE_PASSWORD", "JWT_SECRET",
            "MEILI_MASTER_KEY", "MUSIC_DIRS", "AUDIOBOOK_DIRS", "BACKUP_DIR",
            "PLUGINS_ENABLED", "PLUGINS_DIR", "PLUGIN_MAX_UPLOAD_MB", "PLUGIN_TIMEOUT_MS",
            "PLUGIN_MEMORY_MB", "PLUGIN_MAX_CONCURRENCY", "LISTEN_HOST", "PORT"
        };
        foreach (string key in keys)
        {
            lines.Add(key + "=" + Get(config, key, ""));
        }
        File.WriteAllLines(path, lines.ToArray(), Encoding.UTF8);
    }

    private static Dictionary<string, string> ParseConfig(string[] lines)
    {
        var config = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string rawLine in lines)
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
            {
                continue;
            }
            int separator = line.IndexOf('=');
            if (separator <= 0)
            {
                continue;
            }
            string key = line.Substring(0, separator).Trim();
            string value = line.Substring(separator + 1).Trim();
            if (value.Length >= 2 &&
                ((value[0] == '"' && value[value.Length - 1] == '"') ||
                 (value[0] == '\'' && value[value.Length - 1] == '\'')))
            {
                value = value.Substring(1, value.Length - 2);
            }
            config[key] = value;
        }
        return config;
    }

    private static LauncherSettings LoadLauncherSettings()
    {
        string configPath = Path.Combine(homeRoot, "config.env");
        if (!File.Exists(configPath))
        {
            throw new FileNotFoundException("The MVBar settings file was not found.", configPath);
        }
        Dictionary<string, string> config =
            ParseConfig(File.ReadAllLines(configPath, Encoding.UTF8));
        return new LauncherSettings(
            Get(config, "LISTEN_HOST", "127.0.0.1"),
            ParsePort(Get(config, "PORT", "8080"), 8080),
            SplitDirectories(Get(config, "MUSIC_DIRS", "")),
            SplitDirectories(Get(config, "AUDIOBOOK_DIRS", "")));
    }

    private static void SaveLauncherSettings(LauncherSettings settings)
    {
        if (settings == null)
        {
            throw new ArgumentNullException("settings");
        }
        if (!IsValidListenHost(settings.ListenHost))
        {
            throw new InvalidOperationException(
                "Enter a valid IPv4 address for the network binding.");
        }
        if (settings.Port <= 0 || settings.Port > 65535)
        {
            throw new InvalidOperationException("Enter a port between 1 and 65535.");
        }

        List<string> musicDirectories =
            NormalizeLibraryDirectories(settings.MusicDirectories, "Music");
        if (musicDirectories.Count == 0)
        {
            throw new InvalidOperationException("Add at least one music library folder.");
        }
        List<string> audiobookDirectories =
            NormalizeLibraryDirectories(settings.AudiobookDirectories, "Audiobook");

        string configPath = Path.Combine(homeRoot, "config.env");
        Dictionary<string, string> config =
            ParseConfig(File.ReadAllLines(configPath, Encoding.UTF8));
        config["LISTEN_HOST"] = settings.ListenHost.Trim();
        config["PORT"] = settings.Port.ToString();
        config["MUSIC_DIRS"] = String.Join(",", musicDirectories.ToArray());
        config["AUDIOBOOK_DIRS"] = String.Join(",", audiobookDirectories.ToArray());
        WriteConfig(configPath, config);
        LogLauncher(
            "INFO",
            "Launcher settings updated: bind=" + config["LISTEN_HOST"] +
                ", port=" + config["PORT"] +
                ", musicDirectories=" + musicDirectories.Count +
                ", audiobookDirectories=" + audiobookDirectories.Count);
    }

    private static List<string> NormalizeLibraryDirectories(
        IEnumerable<string> rawDirectories,
        string mediaLabel)
    {
        var directories = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string rawPath in rawDirectories)
        {
            string path = rawPath == null ? "" : rawPath.Trim();
            if (path.Length == 0 || !seen.Add(path))
            {
                continue;
            }
            if (path.IndexOf(',') >= 0)
            {
                throw new InvalidOperationException(
                    mediaLabel + " folder paths cannot contain a comma:\r\n" + path);
            }
            directories.Add(path);
        }
        return directories;
    }

    private static List<string> SplitDirectories(string value)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string item in (value ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string path = item.Trim();
            if (path.Length > 0 && seen.Add(path))
            {
                result.Add(path);
            }
        }
        return result;
    }

    private static bool IsValidListenHost(string value)
    {
        IPAddress address;
        return !String.IsNullOrWhiteSpace(value) &&
            IPAddress.TryParse(value.Trim(), out address) &&
            address.AddressFamily == AddressFamily.InterNetwork;
    }

    private static void ConfigureEnvironment(Dictionary<string, string> config)
    {
        string backupDirectory = Get(config, "BACKUP_DIR", Path.Combine(dataRoot, "backups"));
        string pluginsDirectory = Get(config, "PLUGINS_DIR", Path.Combine(dataRoot, "plugins"));
        Directory.CreateDirectory(backupDirectory);
        Directory.CreateDirectory(pluginsDirectory);
        Environment.SetEnvironmentVariable("NODE_ENV", "production");
        Environment.SetEnvironmentVariable("JWT_SECRET", Get(config, "JWT_SECRET", ""));
        Environment.SetEnvironmentVariable("ADMIN_EMAIL", Get(config, "ADMIN_EMAIL", "admin@local"));
        Environment.SetEnvironmentVariable("ADMIN_PASSWORD", Get(config, "ADMIN_PASSWORD", ""));
        Environment.SetEnvironmentVariable("MEILI_MASTER_KEY", Get(config, "MEILI_MASTER_KEY", ""));
        Environment.SetEnvironmentVariable("MUSIC_DIRS", Get(config, "MUSIC_DIRS", ""));
        Environment.SetEnvironmentVariable("AUDIOBOOK_DIRS", Get(config, "AUDIOBOOK_DIRS", ""));
        Environment.SetEnvironmentVariable("BACKUP_DIR", backupDirectory);
        Environment.SetEnvironmentVariable("PLUGINS_ENABLED", Get(config, "PLUGINS_ENABLED", "true"));
        Environment.SetEnvironmentVariable("PLUGINS_DIR", pluginsDirectory);
        Environment.SetEnvironmentVariable("PLUGIN_MAX_UPLOAD_MB", Get(config, "PLUGIN_MAX_UPLOAD_MB", "50"));
        Environment.SetEnvironmentVariable("PLUGIN_TIMEOUT_MS", Get(config, "PLUGIN_TIMEOUT_MS", "15000"));
        Environment.SetEnvironmentVariable("PLUGIN_MEMORY_MB", Get(config, "PLUGIN_MEMORY_MB", "64"));
        Environment.SetEnvironmentVariable("PLUGIN_MAX_CONCURRENCY", Get(config, "PLUGIN_MAX_CONCURRENCY", "4"));
        Environment.SetEnvironmentVariable("COOKIE_SECURE", "false");
        Environment.SetEnvironmentVariable("TRUST_PROXY", "true");
        Environment.SetEnvironmentVariable("LIBRARY_READ_ONLY", "1");
        Environment.SetEnvironmentVariable("FAST_SCAN", "1");
        Environment.SetEnvironmentVariable("UV_THREADPOOL_SIZE", "16");
        Environment.SetEnvironmentVariable("SCAN_CONCURRENCY", "8");
        Environment.SetEnvironmentVariable("METADATA_TIMEOUT_MS", "300000");
        Environment.SetEnvironmentVariable("RESCAN_INTERVAL_MS", "3600000");
        Environment.SetEnvironmentVariable("TEMPO_DETECT", "0");
        Environment.SetEnvironmentVariable("LOG_LEVEL", "info");
        Environment.SetEnvironmentVariable("APP_VERSION", "standalone-" + BuildId);
        Environment.SetEnvironmentVariable("GIT_COMMIT", BuildId);
        Environment.SetEnvironmentVariable("GIT_BRANCH", "windows-standalone");
        Environment.SetEnvironmentVariable("BUILD_DATE", DateTime.UtcNow.ToString("o"));
    }

    private static Dictionary<string, string> BuildCommonEnvironment(
        Dictionary<string, string> config,
        int pgPort,
        int redisPort,
        int meiliPort)
    {
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string dbPassword = Get(config, "DATABASE_PASSWORD", "");
        environment["DATABASE_URL"] =
            "postgresql://mvbar:" + dbPassword + "@127.0.0.1:" + pgPort + "/mvbar";
        environment["REDIS_URL"] = "redis://127.0.0.1:" + redisPort;
        environment["MEILI_HOST"] = "http://127.0.0.1:" + meiliPort;
        environment["MEILI_MASTER_KEY"] = Get(config, "MEILI_MASTER_KEY", "");
        environment["JWT_SECRET"] = Get(config, "JWT_SECRET", "");
        environment["ADMIN_EMAIL"] = Get(config, "ADMIN_EMAIL", "admin@local");
        environment["ADMIN_PASSWORD"] = Get(config, "ADMIN_PASSWORD", "");
        environment["MUSIC_DIRS"] = Get(config, "MUSIC_DIRS", "");
        environment["AUDIOBOOK_DIRS"] = Get(config, "AUDIOBOOK_DIRS", "");
        environment["LYRICS_DIR"] = Path.Combine(dataRoot, "cache", "lyrics");
        environment["ART_DIR"] = Path.Combine(dataRoot, "cache", "art");
        environment["AVATARS_DIR"] = Path.Combine(dataRoot, "cache", "avatars");
        environment["HLS_DIR"] = Path.Combine(dataRoot, "hls");
        environment["PODCAST_DIR"] = Path.Combine(dataRoot, "podcasts");
        environment["PODCAST_ART_DIR"] = Path.Combine(dataRoot, "cache", "podcast-art");
        environment["AUDIOBOOK_ART_DIR"] = Path.Combine(dataRoot, "cache", "audiobook-art");
        environment["DEVICE_LOG_DIR"] = Path.Combine(dataRoot, "device-logs");
        environment["BACKUP_DIR"] = Get(config, "BACKUP_DIR", Path.Combine(dataRoot, "backups"));
        environment["PLUGINS_ENABLED"] = Get(config, "PLUGINS_ENABLED", "true");
        environment["PLUGINS_DIR"] = Get(config, "PLUGINS_DIR", Path.Combine(dataRoot, "plugins"));
        environment["PLUGIN_MAX_UPLOAD_MB"] = Get(config, "PLUGIN_MAX_UPLOAD_MB", "50");
        environment["PLUGIN_TIMEOUT_MS"] = Get(config, "PLUGIN_TIMEOUT_MS", "15000");
        environment["PLUGIN_MEMORY_MB"] = Get(config, "PLUGIN_MEMORY_MB", "64");
        environment["PLUGIN_MAX_CONCURRENCY"] = Get(config, "PLUGIN_MAX_CONCURRENCY", "4");
        environment["COOKIE_SECURE"] = "false";
        environment["TRUST_PROXY"] = "true";
        environment["LIBRARY_READ_ONLY"] = "1";
        environment["FAST_SCAN"] = "1";
        environment["UV_THREADPOOL_SIZE"] = "16";
        environment["SCAN_CONCURRENCY"] = "8";
        environment["METADATA_TIMEOUT_MS"] = "300000";
        environment["RESCAN_INTERVAL_MS"] = "3600000";
        environment["TEMPO_DETECT"] = "0";
        environment["NODE_ENV"] = "production";
        environment["APP_VERSION"] = "standalone-" + BuildId;
        environment["GIT_COMMIT"] = BuildId;
        environment["GIT_BRANCH"] = "windows-standalone";
        environment["BUILD_DATE"] = DateTime.UtcNow.ToString("o");
        return environment;
    }

    private static void CreateDataDirectories()
    {
        string[] directories =
        {
            dataRoot,
            logRoot,
            Path.Combine(dataRoot, "postgres"),
            Path.Combine(dataRoot, "garnet"),
            Path.Combine(dataRoot, "meili"),
            Path.Combine(dataRoot, "cache", "lyrics"),
            Path.Combine(dataRoot, "cache", "art"),
            Path.Combine(dataRoot, "cache", "avatars"),
            Path.Combine(dataRoot, "cache", "podcast-art"),
            Path.Combine(dataRoot, "cache", "audiobook-art"),
            Path.Combine(dataRoot, "hls"),
            Path.Combine(dataRoot, "podcasts"),
            Path.Combine(dataRoot, "device-logs"),
            Path.Combine(dataRoot, "backups")
        };
        foreach (string directory in directories)
        {
            Directory.CreateDirectory(directory);
        }
    }

    private static void InitializePostgres(string initDbPath)
    {
        if (File.Exists(Path.Combine(pgDataRoot, "PG_VERSION")))
        {
            return;
        }

        ReportStatus("Starting database", "Creating the local database for first use...", 22);
        ToolResult result = RunTool(
            initDbPath,
            Args(
                "--pgdata", pgDataRoot,
                "--username", "postgres",
                "--auth", "trust",
                "--encoding", "UTF8",
                "--locale", "C"),
            homeRoot,
            180);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                "PostgreSQL initialization failed.\r\n" + result.Error);
        }
    }

    private static void PrepareDatabase(
        string psqlPath,
        string createUserPath,
        string createDbPath,
        int port,
        Dictionary<string, string> config)
    {
        string baseArgs = Args(
            "-h", "127.0.0.1",
            "-p", port.ToString(),
            "-U", "postgres",
            "-d", "postgres");
        ToolResult role = RunTool(
            psqlPath,
            baseArgs + " " + Args("-tAc", "SELECT 1 FROM pg_roles WHERE rolname='mvbar'"),
            homeRoot,
            30);
        if (role.Output.Trim() != "1")
        {
            RequireSuccess(
                RunTool(
                    createUserPath,
                    Args(
                        "-h", "127.0.0.1",
                        "-p", port.ToString(),
                        "-U", "postgres",
                        "--login", "mvbar"),
                    homeRoot,
                    30),
                "create the MVBar database user");
        }

        string dbPassword = Get(config, "DATABASE_PASSWORD", "");
        RequireSuccess(
            RunTool(
                psqlPath,
                baseArgs + " " + Args(
                    "-c", "ALTER ROLE mvbar PASSWORD '" + SqlLiteral(dbPassword) + "';"),
                homeRoot,
                30),
            "set the MVBar database password");

        ToolResult database = RunTool(
            psqlPath,
            baseArgs + " " + Args("-tAc", "SELECT 1 FROM pg_database WHERE datname='mvbar'"),
            homeRoot,
            30);
        if (database.Output.Trim() != "1")
        {
            RequireSuccess(
                RunTool(
                    createDbPath,
                    Args(
                        "-h", "127.0.0.1",
                        "-p", port.ToString(),
                        "-U", "postgres",
                        "--owner", "mvbar",
                        "mvbar"),
                    homeRoot,
                    30),
                "create the MVBar database");
        }
    }

    private static void StartService(
        string name,
        string filePath,
        string arguments,
        string workingDirectory,
        Dictionary<string, string> environment)
    {
        LogLauncher("INFO", "Starting service: " + name);
        var startInfo = new ProcessStartInfo();
        startInfo.FileName = filePath;
        startInfo.Arguments = arguments;
        startInfo.WorkingDirectory = workingDirectory;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        if (environment != null)
        {
            foreach (KeyValuePair<string, string> item in environment)
            {
                startInfo.EnvironmentVariables[item.Key] = item.Value;
            }
        }

        var log = new ServiceLog(Path.Combine(logRoot, name + ".log"));
        var process = new Process();
        process.StartInfo = startInfo;
        process.EnableRaisingEvents = true;
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            if (eventArgs.Data != null)
            {
                log.Write("OUT", eventArgs.Data);
            }
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
        {
            if (eventArgs.Data != null)
            {
                log.Write("ERR", eventArgs.Data);
            }
        };

        if (!process.Start())
        {
            log.Dispose();
            throw new InvalidOperationException("Could not start " + name + ".");
        }
        AssignToJob(process);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        Services[name] = process;
        Logs.Add(log);
    }

    private static void MonitorServices()
    {
        while (!shuttingDown)
        {
            Thread.Sleep(1000);
            if (shuttingDown)
            {
                break;
            }
            foreach (KeyValuePair<string, Process> item in Services)
            {
                if (shuttingDown)
                {
                    break;
                }
                if (item.Value.HasExited)
                {
                    throw new InvalidOperationException(
                        item.Key + " stopped unexpectedly with exit code " +
                        item.Value.ExitCode + ". See " +
                        Path.Combine(logRoot, item.Key + ".log"));
                }
            }
        }
    }

    private static void EnsureRunning(string name)
    {
        Process process;
        if (!Services.TryGetValue(name, out process) || process.HasExited)
        {
            throw new InvalidOperationException(
                name + " stopped while starting. See " +
                Path.Combine(logRoot, name + ".log"));
        }
    }

    private static void Shutdown()
    {
        lock (ShutdownSync)
        {
            if (shuttingDown)
            {
                return;
            }
            shuttingDown = true;
        }
        LogLauncher("INFO", "Stopping MVBar services.");

        string[] order =
        {
            "proxy", "web", "worker", "api", "meilisearch", "garnet"
        };
        foreach (string name in order)
        {
            Process process;
            if (Services.TryGetValue(name, out process))
            {
                TryStopProcess(process);
            }
        }

        if (!String.IsNullOrEmpty(pgCtlPath) &&
            File.Exists(pgCtlPath) &&
            !String.IsNullOrEmpty(pgDataRoot) &&
            File.Exists(Path.Combine(pgDataRoot, "PG_VERSION")))
        {
            try
            {
                RunTool(pgCtlPath, Args("-D", pgDataRoot, "-m", "fast", "stop"), homeRoot, 20);
            }
            catch
            {
                Process postgres;
                if (Services.TryGetValue("postgres", out postgres))
                {
                    TryStopProcess(postgres);
                }
            }
        }

        if (jobHandle != IntPtr.Zero)
        {
            CloseHandle(jobHandle);
            jobHandle = IntPtr.Zero;
        }
        foreach (ServiceLog log in Logs)
        {
            log.Dispose();
        }
        LogLauncher("INFO", "MVBar services stopped.");
    }

    private static void TryStopProcess(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill();
                process.WaitForExit(5000);
            }
        }
        catch
        {
            // Job cleanup is the final fallback.
        }
    }

    private static ToolResult RunTool(
        string filePath,
        string arguments,
        string workingDirectory,
        int timeoutSeconds)
    {
        var output = new StringBuilder();
        var error = new StringBuilder();
        var startInfo = new ProcessStartInfo();
        startInfo.FileName = filePath;
        startInfo.Arguments = arguments;
        startInfo.WorkingDirectory = workingDirectory;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        using (var process = new Process())
        {
            process.StartInfo = startInfo;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (eventArgs.Data != null)
                {
                    lock (output)
                    {
                        output.AppendLine(eventArgs.Data);
                    }
                }
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
            {
                if (eventArgs.Data != null)
                {
                    lock (error)
                    {
                        error.AppendLine(eventArgs.Data);
                    }
                }
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (!process.WaitForExit(timeoutSeconds * 1000))
            {
                process.Kill();
                throw new TimeoutException(Path.GetFileName(filePath) + " timed out.");
            }
            process.WaitForExit();
            return new ToolResult(process.ExitCode, output.ToString(), error.ToString());
        }
    }

    private static void WaitForTcp(string host, int port, int timeoutSeconds)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        while (DateTime.UtcNow < deadline)
        {
            using (var client = new TcpClient())
            {
                try
                {
                    IAsyncResult attempt = client.BeginConnect(host, port, null, null);
                    if (attempt.AsyncWaitHandle.WaitOne(500) && client.Connected)
                    {
                        client.EndConnect(attempt);
                        return;
                    }
                }
                catch
                {
                }
            }
            Thread.Sleep(250);
        }
        throw new TimeoutException("Timed out waiting for " + host + ":" + port + ".");
    }

    private static void WaitForHttp(string url, int timeoutSeconds)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 3000;
                request.ReadWriteTimeout = 3000;
                request.Proxy = null;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 500)
                    {
                        return;
                    }
                }
            }
            catch
            {
            }
            Thread.Sleep(500);
        }
        throw new TimeoutException("Timed out waiting for " + url + ".");
    }

    private static void WaitForPostgres(string psqlPath, int port, int timeoutSeconds)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                ToolResult result = RunTool(
                    psqlPath,
                    Args(
                        "-h", "127.0.0.1",
                        "-p", port.ToString(),
                        "-U", "postgres",
                        "-d", "postgres",
                        "-tAc", "SELECT 1"),
                    homeRoot,
                    5);
                if (result.ExitCode == 0 && result.Output.Trim() == "1")
                {
                    return;
                }
            }
            catch
            {
            }
            Thread.Sleep(500);
        }
        throw new TimeoutException("Timed out waiting for PostgreSQL to accept queries.");
    }

    private static int FindFreePort(int preferred)
    {
        if (PortIsAvailable(preferred))
        {
            return preferred;
        }
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static int FindAvailablePort(int preferred, int attempts)
    {
        for (int index = 0; index < attempts; index++)
        {
            int port = preferred + index;
            if (port < 65536 && PortIsAvailable(port))
            {
                return port;
            }
        }
        return FindFreePort(0);
    }

    private static bool PortIsAvailable(int port)
    {
        if (port <= 0 || port > 65535)
        {
            return false;
        }
        try
        {
            foreach (IPEndPoint endpoint in
                IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            {
                if (endpoint.Port == port)
                {
                    return false;
                }
            }
        }
        catch
        {
            // The bind attempt below remains the final authority.
        }
        TcpListener listener = null;
        try
        {
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            if (listener != null)
            {
                listener.Stop();
            }
        }
    }

    private static string EnsurePayloadExtracted()
    {
        string applicationsRoot = Path.Combine(homeRoot, "app");
        string versionRoot = Path.Combine(applicationsRoot, BuildId);
        string marker = Path.Combine(versionRoot, ".complete");
        if (File.Exists(marker))
        {
            return versionRoot;
        }

        Directory.CreateDirectory(applicationsRoot);
        CleanupStaleExtractions(applicationsRoot);
        string temporaryRoot = versionRoot + ".extracting-" +
            Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(temporaryRoot);

        ReportStatus("Preparing MVBar", "Extracting the bundled application files...", 3);
        string executablePath = Assembly.GetExecutingAssembly().Location;
        using (var executable = new FileStream(
            executablePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            long payloadLength = ReadPayloadLength(executable);
            long payloadOffset = executable.Length - 16 - payloadLength;
            if (payloadLength <= 0 || payloadOffset <= 0)
            {
                throw new InvalidDataException("The embedded MVBar payload is invalid.");
            }

            using (var payload = new SegmentStream(executable, payloadOffset, payloadLength))
            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read, false))
            {
                ExtractArchive(archive, temporaryRoot);
            }
        }

        File.WriteAllText(Path.Combine(temporaryRoot, ".complete"), BuildId, Encoding.UTF8);
        PromoteExtractedPayload(temporaryRoot, versionRoot);
        CleanupOldVersions(applicationsRoot, versionRoot);
        return versionRoot;
    }

    private static void PromoteExtractedPayload(string temporaryRoot, string versionRoot)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(60);
        Exception lastError = null;
        int delayMilliseconds = 250;

        while (DateTime.UtcNow < deadline)
        {
            try
            {
                if (Directory.Exists(versionRoot))
                {
                    if (File.Exists(Path.Combine(versionRoot, ".complete")))
                    {
                        TryDeleteDirectory(temporaryRoot);
                        return;
                    }
                    Directory.Delete(versionRoot, true);
                }
                Directory.Move(temporaryRoot, versionRoot);
                return;
            }
            catch (IOException error)
            {
                lastError = error;
            }
            catch (UnauthorizedAccessException error)
            {
                lastError = error;
            }

            Thread.Sleep(delayMilliseconds);
            delayMilliseconds = Math.Min(delayMilliseconds * 2, 2000);
        }

        throw new InvalidOperationException(
            "Windows kept the completed MVBar payload locked for 60 seconds. " +
            "Close antivirus scan dialogs and run the EXE again. Completed files remain at: " +
            temporaryRoot,
            lastError);
    }

    private static void CleanupStaleExtractions(string applicationsRoot)
    {
        string pattern = BuildId + ".extracting-*";
        foreach (string directory in Directory.GetDirectories(applicationsRoot, pattern))
        {
            TryDeleteDirectory(directory);
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, true);
        }
        catch
        {
            // A stale folder can be retried on a future launch.
        }
    }

    private static long ReadPayloadLength(FileStream executable)
    {
        if (executable.Length < 16)
        {
            throw new InvalidDataException("No embedded MVBar payload was found.");
        }
        var magic = new byte[8];
        executable.Seek(-8, SeekOrigin.End);
        ReadExactly(executable, magic, 0, magic.Length);
        if (!String.Equals(
            Encoding.ASCII.GetString(magic),
            PayloadMagic,
            StringComparison.Ordinal))
        {
            throw new InvalidDataException("No embedded MVBar payload was found.");
        }

        var lengthBytes = new byte[8];
        executable.Seek(-16, SeekOrigin.End);
        ReadExactly(executable, lengthBytes, 0, lengthBytes.Length);
        return BitConverter.ToInt64(lengthBytes, 0);
    }

    private static void ExtractArchive(ZipArchive archive, string destination)
    {
        string root = Path.GetFullPath(destination);
        if (!root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
        {
            root += Path.DirectorySeparatorChar;
        }

        int total = archive.Entries.Count;
        int completed = 0;
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            string target = Path.GetFullPath(Path.Combine(root, relative));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Unsafe path in embedded payload: " + entry.FullName);
            }
            if (String.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(target);
                completed++;
                if (completed == total || completed % 50 == 0)
                {
                    ReportExtractionProgress(completed, total);
                }
                continue;
            }
            string parent = Path.GetDirectoryName(target);
            if (!String.IsNullOrEmpty(parent))
            {
                Directory.CreateDirectory(parent);
            }
            using (Stream input = entry.Open())
            using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                input.CopyTo(output);
            }
            File.SetLastWriteTime(target, entry.LastWriteTime.LocalDateTime);
            completed++;
            if (completed == total || completed % 50 == 0)
            {
                ReportExtractionProgress(completed, total);
            }
        }
    }

    private static void CleanupOldVersions(string applicationsRoot, string currentRoot)
    {
        foreach (string directory in Directory.GetDirectories(applicationsRoot))
        {
            if (String.Equals(
                Path.GetFullPath(directory),
                Path.GetFullPath(currentRoot),
                StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            try
            {
                Directory.Delete(directory, true);
            }
            catch
            {
                // An older version can be removed on a future start.
            }
        }
    }

    private static void OpenExistingInstance()
    {
        string root = Environment.GetEnvironmentVariable("MVBAR_HOME");
        if (String.IsNullOrWhiteSpace(root))
        {
            root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MVBar");
        }
        string urlPath = Path.Combine(root, "runtime.url");
        if (File.Exists(urlPath))
        {
            OpenUrl(File.ReadAllText(urlPath, Encoding.UTF8).Trim());
        }
        else
        {
            TryShowMessage("MVBar is already starting.", "MVBar");
        }
    }

    private static void OpenUrl(string url)
    {
        if (String.IsNullOrWhiteSpace(url))
        {
            return;
        }
        try
        {
            var startInfo = new ProcessStartInfo(url);
            startInfo.UseShellExecute = true;
            Process.Start(startInfo);
        }
        catch
        {
            LogLauncher("WARN", "Could not open the default browser for " + url);
        }
    }

    private static void TryShowMessage(string message, string title)
    {
        try
        {
            MessageBox.Show(message, title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch
        {
        }
    }

    private static void RequireFiles(IEnumerable<string> paths)
    {
        foreach (string path in paths)
        {
            if (!File.Exists(path))
            {
                throw new FileNotFoundException("A bundled runtime file is missing.", path);
            }
        }
    }

    private static void RequireSuccess(ToolResult result, string action)
    {
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(
                "Could not " + action + ".\r\n" + result.Error);
        }
    }

    private static string AppPath(params string[] parts)
    {
        string path = appRoot;
        foreach (string part in parts)
        {
            path = Path.Combine(path, part);
        }
        return path;
    }

    private static string Get(
        Dictionary<string, string> values,
        string key,
        string fallback)
    {
        string value;
        return values.TryGetValue(key, out value) && !String.IsNullOrWhiteSpace(value)
            ? value
            : fallback;
    }

    private static Dictionary<string, string> CopyEnvironment(
        Dictionary<string, string> source)
    {
        return new Dictionary<string, string>(source, StringComparer.OrdinalIgnoreCase);
    }

    private static int ParsePort(string value, int fallback)
    {
        int port;
        return Int32.TryParse(value, out port) && port > 0 && port < 65536
            ? port
            : fallback;
    }

    private static string RandomText(int length)
    {
        const string characters =
            "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        var bytes = new byte[length];
        var result = new char[length];
        using (var random = new RNGCryptoServiceProvider())
        {
            random.GetBytes(bytes);
        }
        for (int index = 0; index < result.Length; index++)
        {
            result[index] = characters[bytes[index] % characters.Length];
        }
        return new string(result);
    }

    private static string RandomHex(int byteCount)
    {
        var bytes = new byte[byteCount];
        using (var random = new RNGCryptoServiceProvider())
        {
            random.GetBytes(bytes);
        }
        var result = new StringBuilder(byteCount * 2);
        foreach (byte value in bytes)
        {
            result.Append(value.ToString("x2"));
        }
        return result.ToString();
    }

    private static string SqlLiteral(string value)
    {
        return value.Replace("'", "''");
    }

    private static string Args(params string[] values)
    {
        var result = new StringBuilder();
        foreach (string value in values)
        {
            if (result.Length > 0)
            {
                result.Append(' ');
            }
            result.Append(QuoteArgument(value));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value == null)
        {
            return "\"\"";
        }
        if (value.Length > 0 &&
            value.IndexOfAny(new[] { ' ', '\t', '\r', '\n', '"' }) < 0)
        {
            return value;
        }
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        while (count > 0)
        {
            int read = stream.Read(buffer, offset, count);
            if (read <= 0)
            {
                throw new EndOfStreamException();
            }
            offset += read;
            count -= read;
        }
    }

    private static void CreateJob()
    {
        jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero)
        {
            throw new InvalidOperationException("Could not create the MVBar process group.");
        }

        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!SetInformationJobObject(
                jobHandle,
                JobObjectInfoType.ExtendedLimitInformation,
                pointer,
                (uint)length))
            {
                throw new InvalidOperationException("Could not configure the MVBar process group.");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static void AssignToJob(Process process)
    {
        if (!AssignProcessToJobObject(jobHandle, process.Handle))
        {
            process.Kill();
            throw new InvalidOperationException(
                "Could not supervise " + process.ProcessName + ".");
        }
    }

    private sealed class LauncherSettings
    {
        internal readonly string ListenHost;
        internal readonly int Port;
        internal readonly List<string> MusicDirectories;
        internal readonly List<string> AudiobookDirectories;

        internal LauncherSettings(
            string listenHost,
            int port,
            IEnumerable<string> musicDirectories,
            IEnumerable<string> audiobookDirectories)
        {
            ListenHost = listenHost;
            Port = port;
            MusicDirectories = new List<string>(musicDirectories);
            AudiobookDirectories = new List<string>(audiobookDirectories);
        }
    }

    private sealed class LauncherForm : Form
    {
        private readonly Label statusLabel;
        private readonly Label detailLabel;
        private readonly ProgressBar progressBar;
        private readonly GroupBox credentialsGroup;
        private readonly TextBox emailBox;
        private readonly TextBox passwordBox;
        private readonly Label credentialLocationLabel;
        private readonly Button revealButton;
        private readonly Button openButton;
        private readonly Button backgroundButton;
        private readonly Button settingsButton;
        private readonly Button exitButton;
        private readonly NotifyIcon trayIcon;
        private readonly ToolStripMenuItem trayOpenItem;
        private readonly ToolStripMenuItem trayCredentialsItem;
        private readonly ToolStripMenuItem traySettingsItem;
        private readonly Icon applicationIcon;
        private string readyUrl;
        private string readyCredentialsPath;
        private bool startupStarted;
        private bool allowClose;
        private bool startupFailed;
        private bool backgroundTipShown;

        internal LauncherForm()
        {
            Text = "MVBar Standalone";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            ShowInTaskbar = true;
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(620, 270);
            MinimumSize = new Size(636, 309);
            BackColor = Color.FromArgb(247, 248, 250);

            applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (applicationIcon != null)
            {
                Icon = applicationIcon;
            }

            var header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 82;
            header.BackColor = Color.FromArgb(18, 24, 38);
            Controls.Add(header);

            if (applicationIcon != null)
            {
                var logo = new PictureBox();
                logo.Location = new Point(24, 17);
                logo.Size = new Size(48, 48);
                logo.SizeMode = PictureBoxSizeMode.Zoom;
                logo.Image = applicationIcon.ToBitmap();
                header.Controls.Add(logo);
            }

            var title = new Label();
            title.AutoSize = true;
            title.Location = new Point(86, 18);
            title.Font = new Font("Segoe UI", 18F, FontStyle.Bold);
            title.ForeColor = Color.White;
            title.Text = "MVBar";
            header.Controls.Add(title);

            var subtitle = new Label();
            subtitle.AutoSize = true;
            subtitle.Location = new Point(88, 51);
            subtitle.Font = new Font("Segoe UI", 9F);
            subtitle.ForeColor = Color.FromArgb(183, 193, 211);
            subtitle.Text = "Your private music server";
            header.Controls.Add(subtitle);

            var content = new Panel();
            content.Dock = DockStyle.Fill;
            content.BackColor = BackColor;
            Controls.Add(content);
            content.BringToFront();

            statusLabel = new Label();
            statusLabel.Location = new Point(24, 18);
            statusLabel.Size = new Size(552, 30);
            statusLabel.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
            statusLabel.ForeColor = Color.FromArgb(22, 29, 45);
            statusLabel.Text = "Starting MVBar";
            content.Controls.Add(statusLabel);

            detailLabel = new Label();
            detailLabel.Location = new Point(24, 52);
            detailLabel.Size = new Size(552, 42);
            detailLabel.Font = new Font("Segoe UI", 9.5F);
            detailLabel.ForeColor = Color.FromArgb(83, 94, 115);
            detailLabel.Text = "Preparing the local application...";
            content.Controls.Add(detailLabel);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(24, 99);
            progressBar.Size = new Size(552, 12);
            progressBar.Minimum = 0;
            progressBar.Maximum = 100;
            progressBar.Style = ProgressBarStyle.Continuous;
            progressBar.Value = 1;
            content.Controls.Add(progressBar);

            credentialsGroup = new GroupBox();
            credentialsGroup.Location = new Point(24, 128);
            credentialsGroup.Size = new Size(552, 190);
            credentialsGroup.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            credentialsGroup.ForeColor = Color.FromArgb(37, 47, 66);
            credentialsGroup.Text = "Administrator sign-in";
            credentialsGroup.Visible = false;
            content.Controls.Add(credentialsGroup);

            AddFieldLabel(credentialsGroup, "Email", 17, 29);
            emailBox = CreateReadOnlyField(17, 48, 412);
            credentialsGroup.Controls.Add(emailBox);
            credentialsGroup.Controls.Add(CreateButton(
                "Copy",
                439,
                46,
                94,
                delegate { CopyValue(emailBox.Text, "Email copied."); }));

            AddFieldLabel(credentialsGroup, "Password", 17, 83);
            passwordBox = CreateReadOnlyField(17, 102, 307);
            passwordBox.UseSystemPasswordChar = true;
            credentialsGroup.Controls.Add(passwordBox);

            revealButton = CreateButton(
                "Show",
                334,
                100,
                95,
                delegate
                {
                    passwordBox.UseSystemPasswordChar = !passwordBox.UseSystemPasswordChar;
                    revealButton.Text = passwordBox.UseSystemPasswordChar ? "Show" : "Hide";
                });
            credentialsGroup.Controls.Add(revealButton);
            credentialsGroup.Controls.Add(CreateButton(
                "Copy",
                439,
                100,
                94,
                delegate { CopyValue(passwordBox.Text, "Password copied."); }));

            credentialsGroup.Controls.Add(CreateButton(
                "Copy sign-in",
                17,
                144,
                116,
                delegate
                {
                    CopyValue(
                        "Email: " + emailBox.Text + Environment.NewLine +
                            "Password: " + passwordBox.Text,
                        "Sign-in details copied.");
                }));
            credentialsGroup.Controls.Add(CreateButton(
                "Open saved file",
                142,
                144,
                128,
                delegate { OpenPath(readyCredentialsPath); }));

            credentialLocationLabel = new Label();
            credentialLocationLabel.Location = new Point(282, 149);
            credentialLocationLabel.Size = new Size(250, 32);
            credentialLocationLabel.Font = new Font("Segoe UI", 8F);
            credentialLocationLabel.ForeColor = Color.FromArgb(103, 113, 132);
            credentialLocationLabel.TextAlign = ContentAlignment.TopRight;
            credentialsGroup.Controls.Add(credentialLocationLabel);

            var footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 72;
            footer.BackColor = Color.White;
            footer.Paint += delegate(object sender, PaintEventArgs eventArgs)
            {
                eventArgs.Graphics.DrawLine(
                    Pens.Gainsboro,
                    0,
                    0,
                    footer.ClientSize.Width,
                    0);
            };
            Controls.Add(footer);
            footer.BringToFront();

            openButton = CreateButton(
                "Open MVBar",
                24,
                18,
                124,
                delegate { OpenUrl(readyUrl); });
            openButton.Enabled = false;
            footer.Controls.Add(openButton);

            backgroundButton = CreateButton(
                "Run in background",
                160,
                18,
                145,
                delegate { HideToTray(); });
            footer.Controls.Add(backgroundButton);

            settingsButton = CreateButton(
                "Settings",
                317,
                18,
                108,
                delegate { OpenSettings(); });
            settingsButton.Enabled = false;
            footer.Controls.Add(settingsButton);

            exitButton = CreateButton(
                "Exit MVBar",
                472,
                18,
                104,
                delegate { ExitFromUi(); });
            footer.Controls.Add(exitButton);

            var trayMenu = new ContextMenuStrip();
            trayOpenItem = new ToolStripMenuItem("Open MVBar");
            trayOpenItem.Enabled = false;
            trayOpenItem.Click += delegate { OpenUrl(readyUrl); };
            trayMenu.Items.Add(trayOpenItem);
            trayMenu.Items.Add(new ToolStripMenuItem(
                "Show status",
                null,
                delegate { ShowWindow(); }));
            trayCredentialsItem = new ToolStripMenuItem("Administrator sign-in");
            trayCredentialsItem.Enabled = false;
            trayCredentialsItem.Click += delegate
            {
                ShowWindow();
                passwordBox.Focus();
            };
            trayMenu.Items.Add(trayCredentialsItem);
            traySettingsItem = new ToolStripMenuItem("Settings...");
            traySettingsItem.Enabled = false;
            traySettingsItem.Click += delegate { OpenSettings(); };
            trayMenu.Items.Add(traySettingsItem);
            trayMenu.Items.Add(new ToolStripMenuItem(
                "Open logs",
                null,
                delegate { OpenPath(logRoot); }));
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(new ToolStripMenuItem(
                "Exit MVBar",
                null,
                delegate { ExitFromUi(); }));

            trayIcon = new NotifyIcon();
            trayIcon.Text = "MVBar";
            trayIcon.Icon = applicationIcon;
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { ShowWindow(); };
        }

        protected override void OnShown(EventArgs eventArgs)
        {
            base.OnShown(eventArgs);
            if (!startupStarted)
            {
                startupStarted = true;
                ThreadPool.QueueUserWorkItem(delegate { StartInteractive(); });
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs eventArgs)
        {
            if (!allowClose && !startupFailed)
            {
                eventArgs.Cancel = true;
                HideToTray();
                return;
            }
            base.OnFormClosing(eventArgs);
        }

        protected override void OnFormClosed(FormClosedEventArgs eventArgs)
        {
            trayIcon.Visible = false;
            trayIcon.Dispose();
            if (applicationIcon != null)
            {
                applicationIcon.Dispose();
            }
            base.OnFormClosed(eventArgs);
        }

        internal void Post(Action<LauncherForm> action)
        {
            if (IsDisposed || Disposing)
            {
                return;
            }
            try
            {
                if (InvokeRequired)
                {
                    BeginInvoke(new MethodInvoker(delegate { action(this); }));
                }
                else
                {
                    action(this);
                }
            }
            catch (InvalidOperationException)
            {
                // The form is already closing.
            }
        }

        internal void SetStatus(string title, string detail, int progress)
        {
            statusLabel.Text = title;
            detailLabel.Text = detail;
            progressBar.Style = ProgressBarStyle.Continuous;
            progressBar.Value = Math.Max(
                progressBar.Minimum,
                Math.Min(progressBar.Maximum, progress));
        }

        internal void ShowReady(
            string url,
            string administrator,
            string password,
            string credentialsPath,
            bool firstRun)
        {
            readyUrl = url;
            readyCredentialsPath = credentialsPath;
            emailBox.Text = administrator;
            passwordBox.Text = password;
            credentialLocationLabel.Text = credentialsPath;
            credentialsGroup.Visible = true;
            ClientSize = new Size(620, 485);
            MinimumSize = new Size(636, 524);
            SetStatus(
                "MVBar is ready",
                "The server is running locally. Closing this window keeps it running in the notification area.",
                100);
            openButton.Enabled = true;
            trayOpenItem.Enabled = true;
            trayCredentialsItem.Enabled = true;
            traySettingsItem.Enabled = true;
            settingsButton.Enabled = true;
            trayIcon.Text = "MVBar is running";

            if (firstRun)
            {
                ShowWindow();
                TopMost = true;
                var releaseForeground = new System.Windows.Forms.Timer();
                releaseForeground.Interval = 1800;
                releaseForeground.Tick += delegate
                {
                    releaseForeground.Stop();
                    TopMost = false;
                    releaseForeground.Dispose();
                };
                releaseForeground.Start();
            }
        }

        internal void ShowFailure(string message, string launcherLogPath)
        {
            startupFailed = true;
            ShowWindow();
            statusLabel.Text = "MVBar could not start";
            detailLabel.Text = message +
                (String.IsNullOrWhiteSpace(launcherLogPath)
                    ? ""
                    : Environment.NewLine + "Details: " + launcherLogPath);
            detailLabel.ForeColor = Color.FromArgb(168, 42, 42);
            progressBar.Style = ProgressBarStyle.Continuous;
            progressBar.Value = 0;
            backgroundButton.Enabled = false;
            settingsButton.Enabled = false;
            openButton.Enabled = false;
            exitButton.Text = "Close";
            trayIcon.Text = "MVBar needs attention";
        }

        internal void ShowStopping()
        {
            ShowWindow();
            statusLabel.Text = "Stopping MVBar";
            detailLabel.Text = "Closing the local services and saving their data...";
            progressBar.Style = ProgressBarStyle.Marquee;
            openButton.Enabled = false;
            backgroundButton.Enabled = false;
            settingsButton.Enabled = false;
            exitButton.Enabled = false;
        }

        internal void ShowRestarting()
        {
            ShowWindow();
            statusLabel.Text = "Restarting MVBar";
            detailLabel.Text = "Applying launcher settings and restarting the local services...";
            progressBar.Style = ProgressBarStyle.Marquee;
            openButton.Enabled = false;
            backgroundButton.Enabled = false;
            settingsButton.Enabled = false;
            exitButton.Enabled = false;
            trayOpenItem.Enabled = false;
            trayCredentialsItem.Enabled = false;
            traySettingsItem.Enabled = false;
        }

        internal void CompleteExit()
        {
            allowClose = true;
            Close();
        }

        private void ShowWindow()
        {
            Show();
            WindowState = FormWindowState.Normal;
            ShowInTaskbar = true;
            Activate();
            BringToFront();
        }

        private void HideToTray()
        {
            Hide();
            ShowInTaskbar = false;
            if (!backgroundTipShown)
            {
                backgroundTipShown = true;
                trayIcon.ShowBalloonTip(
                    3000,
                    "MVBar is still running",
                    "Use the MVBar icon in the notification area to reopen or exit.",
                    ToolTipIcon.Info);
            }
        }

        private void CopyValue(string value, string confirmation)
        {
            if (String.IsNullOrEmpty(value))
            {
                return;
            }
            try
            {
                Clipboard.SetText(value);
                detailLabel.Text = confirmation;
            }
            catch (ExternalException)
            {
                detailLabel.Text = "Windows could not access the clipboard. Please try again.";
            }
        }

        private void OpenSettings()
        {
            try
            {
                TopMost = false;
                LauncherSettings currentSettings = LoadLauncherSettings();
                using (var dialog = new SettingsForm(currentSettings, applicationIcon))
                {
                    if (dialog.ShowDialog(this) == DialogResult.OK)
                    {
                        SaveLauncherSettings(dialog.Settings);
                        RestartFromUi();
                    }
                }
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    this,
                    "MVBar could not save the launcher settings.\r\n\r\n" + error.Message,
                    "MVBar settings",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private static TextBox CreateReadOnlyField(int x, int y, int width)
        {
            var field = new TextBox();
            field.Location = new Point(x, y);
            field.Size = new Size(width, 28);
            field.Font = new Font("Segoe UI", 10F);
            field.ReadOnly = true;
            field.BackColor = Color.White;
            field.BorderStyle = BorderStyle.FixedSingle;
            return field;
        }

        private static void AddFieldLabel(Control parent, string text, int x, int y)
        {
            var label = new Label();
            label.AutoSize = true;
            label.Location = new Point(x, y);
            label.Font = new Font("Segoe UI", 8.5F, FontStyle.Regular);
            label.ForeColor = Color.FromArgb(83, 94, 115);
            label.Text = text;
            parent.Controls.Add(label);
        }

        private static Button CreateButton(
            string text,
            int x,
            int y,
            int width,
            Action action)
        {
            var button = new Button();
            button.Location = new Point(x, y);
            button.Size = new Size(width, 30);
            button.Font = new Font("Segoe UI", 9F);
            button.Text = text;
            button.UseVisualStyleBackColor = true;
            button.Click += delegate { action(); };
            return button;
        }

        private static void OpenPath(string path)
        {
            if (String.IsNullOrWhiteSpace(path))
            {
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch
            {
                TryShowMessage("Windows could not open:\r\n" + path, "MVBar");
            }
        }
    }

    private sealed class SettingsForm : Form
    {
        private readonly ComboBox bindingModeBox;
        private readonly TextBox customAddressBox;
        private readonly NumericUpDown portBox;
        private readonly ListBox musicFoldersList;
        private readonly ListBox audiobookFoldersList;

        internal LauncherSettings Settings { get; private set; }

        internal SettingsForm(LauncherSettings settings, Icon applicationIcon)
        {
            Text = "MVBar settings";
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(650, 610);
            BackColor = Color.FromArgb(247, 248, 250);
            if (applicationIcon != null)
            {
                Icon = applicationIcon;
            }

            var title = new Label();
            title.AutoSize = true;
            title.Location = new Point(24, 18);
            title.Font = new Font("Segoe UI", 16F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(22, 29, 45);
            title.Text = "Launcher settings";
            Controls.Add(title);

            var introduction = new Label();
            introduction.Location = new Point(26, 52);
            introduction.Size = new Size(596, 36);
            introduction.Font = new Font("Segoe UI", 9F);
            introduction.ForeColor = Color.FromArgb(83, 94, 115);
            introduction.Text =
                "Choose where MVBar is available and which folders make up each media library.";
            Controls.Add(introduction);

            var networkGroup = new GroupBox();
            networkGroup.Location = new Point(24, 88);
            networkGroup.Size = new Size(602, 164);
            networkGroup.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            networkGroup.ForeColor = Color.FromArgb(37, 47, 66);
            networkGroup.Text = "Network";
            Controls.Add(networkGroup);

            AddDialogLabel(networkGroup, "Network access", 18, 29);
            bindingModeBox = new ComboBox();
            bindingModeBox.Location = new Point(18, 49);
            bindingModeBox.Size = new Size(365, 28);
            bindingModeBox.DropDownStyle = ComboBoxStyle.DropDownList;
            bindingModeBox.Font = new Font("Segoe UI", 9.5F);
            bindingModeBox.Items.Add("This computer only");
            bindingModeBox.Items.Add("Local network and this computer");
            bindingModeBox.Items.Add("Specific network address");
            bindingModeBox.SelectedIndexChanged += delegate { UpdateBindingControls(); };
            networkGroup.Controls.Add(bindingModeBox);

            AddDialogLabel(networkGroup, "Port", 430, 29);
            portBox = new NumericUpDown();
            portBox.Location = new Point(430, 49);
            portBox.Size = new Size(150, 28);
            portBox.Font = new Font("Segoe UI", 9.5F);
            portBox.Minimum = 1;
            portBox.Maximum = 65535;
            portBox.Value = settings.Port;
            networkGroup.Controls.Add(portBox);

            AddDialogLabel(networkGroup, "Specific address", 18, 88);
            customAddressBox = new TextBox();
            customAddressBox.Location = new Point(18, 108);
            customAddressBox.Size = new Size(562, 28);
            customAddressBox.Font = new Font("Segoe UI", 9.5F);
            networkGroup.Controls.Add(customAddressBox);

            var networkHint = new Label();
            networkHint.Location = new Point(18, 137);
            networkHint.Size = new Size(562, 19);
            networkHint.Font = new Font("Segoe UI", 8F);
            networkHint.ForeColor = Color.FromArgb(103, 113, 132);
            networkHint.Text =
                "Local network uses 0.0.0.0. Windows Firewall still controls which devices can connect.";
            networkGroup.Controls.Add(networkHint);

            if (String.Equals(settings.ListenHost, "127.0.0.1", StringComparison.OrdinalIgnoreCase))
            {
                bindingModeBox.SelectedIndex = 0;
                customAddressBox.Text = "127.0.0.1";
            }
            else if (String.Equals(settings.ListenHost, "0.0.0.0", StringComparison.OrdinalIgnoreCase))
            {
                bindingModeBox.SelectedIndex = 1;
                customAddressBox.Text = "0.0.0.0";
            }
            else
            {
                bindingModeBox.SelectedIndex = 2;
                customAddressBox.Text = settings.ListenHost;
            }
            UpdateBindingControls();

            var mediaGroup = new GroupBox();
            mediaGroup.Location = new Point(24, 268);
            mediaGroup.Size = new Size(602, 270);
            mediaGroup.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            mediaGroup.ForeColor = Color.FromArgb(37, 47, 66);
            mediaGroup.Text = "Media libraries";
            Controls.Add(mediaGroup);

            var libraryTabs = new TabControl();
            libraryTabs.Location = new Point(14, 24);
            libraryTabs.Size = new Size(570, 230);
            libraryTabs.Font = new Font("Segoe UI", 9F);
            mediaGroup.Controls.Add(libraryTabs);

            LibraryTabControls musicTab = CreateLibraryTab(
                "Music",
                "At least one music folder is required.",
                "Select a music library folder",
                @"Examples: C:\Music or \\nas\music",
                settings.MusicDirectories);
            musicFoldersList = musicTab.Folders;
            libraryTabs.TabPages.Add(musicTab.Page);

            LibraryTabControls audiobookTab = CreateLibraryTab(
                "Audiobooks",
                "Optional. Leave this list empty when audiobooks are not used.",
                "Select an audiobook library folder",
                @"Examples: C:\Audiobooks or \\nas\audiobooks",
                settings.AudiobookDirectories);
            audiobookFoldersList = audiobookTab.Folders;
            libraryTabs.TabPages.Add(audiobookTab.Page);

            var saveButton = CreateDialogButton(
                "Save and restart",
                468,
                558,
                158,
                delegate { SaveSettings(); });
            Controls.Add(saveButton);

            var cancelButton = CreateDialogButton(
                "Cancel",
                366,
                558,
                90,
                delegate
                {
                    DialogResult = DialogResult.Cancel;
                    Close();
                });
            Controls.Add(cancelButton);
            AcceptButton = saveButton;
            CancelButton = cancelButton;
        }

        private void UpdateBindingControls()
        {
            bool custom = bindingModeBox.SelectedIndex == 2;
            customAddressBox.Enabled = custom;
            customAddressBox.BackColor = custom
                ? Color.White
                : Color.FromArgb(235, 237, 241);
        }

        private LibraryTabControls CreateLibraryTab(
            string title,
            string hintText,
            string browserDescription,
            string exampleText,
            IEnumerable<string> directories)
        {
            var page = new TabPage(title);
            page.BackColor = Color.FromArgb(247, 248, 250);
            page.Padding = new Padding(8);

            var hint = new Label();
            hint.Location = new Point(10, 10);
            hint.Size = new Size(522, 20);
            hint.Font = new Font("Segoe UI", 8.5F);
            hint.ForeColor = Color.FromArgb(83, 94, 115);
            hint.Text = hintText;
            page.Controls.Add(hint);

            var folders = new ListBox();
            folders.Location = new Point(10, 34);
            folders.Size = new Size(430, 86);
            folders.Font = new Font("Segoe UI", 9.5F);
            folders.HorizontalScrollbar = true;
            foreach (string path in directories)
            {
                folders.Items.Add(path);
            }
            page.Controls.Add(folders);

            page.Controls.Add(CreateDialogButton(
                "Browse...",
                450,
                34,
                82,
                delegate { BrowseForLibraryFolder(folders, browserDescription); }));
            page.Controls.Add(CreateDialogButton(
                "Remove",
                450,
                72,
                82,
                delegate
                {
                    int selectedIndex = folders.SelectedIndex;
                    if (selectedIndex >= 0)
                    {
                        folders.Items.RemoveAt(selectedIndex);
                    }
                }));

            AddDialogLabel(page, "Add a local or network path", 10, 128);
            var pathBox = new TextBox();
            pathBox.Location = new Point(10, 148);
            pathBox.Size = new Size(430, 28);
            pathBox.Font = new Font("Segoe UI", 9.5F);
            pathBox.KeyDown += delegate(object sender, KeyEventArgs eventArgs)
            {
                if (eventArgs.KeyCode == Keys.Enter)
                {
                    eventArgs.SuppressKeyPress = true;
                    AddEnteredLibraryPath(folders, pathBox);
                }
            };
            page.Controls.Add(pathBox);
            page.Controls.Add(CreateDialogButton(
                "Add",
                450,
                146,
                82,
                delegate { AddEnteredLibraryPath(folders, pathBox); }));

            var pathHint = new Label();
            pathHint.Location = new Point(10, 179);
            pathHint.Size = new Size(522, 18);
            pathHint.Font = new Font("Segoe UI", 8F);
            pathHint.ForeColor = Color.FromArgb(103, 113, 132);
            pathHint.Text = exampleText;
            page.Controls.Add(pathHint);

            return new LibraryTabControls(page, folders);
        }

        private void BrowseForLibraryFolder(
            ListBox folders,
            string browserDescription)
        {
            using (var browser = new FolderBrowserDialog())
            {
                browser.Description = browserDescription;
                browser.ShowNewFolderButton = false;
                if (folders.SelectedItem != null)
                {
                    string selectedPath = folders.SelectedItem.ToString();
                    if (Directory.Exists(selectedPath))
                    {
                        browser.SelectedPath = selectedPath;
                    }
                }
                if (browser.ShowDialog(this) == DialogResult.OK)
                {
                    AddLibraryPath(folders, browser.SelectedPath);
                }
            }
        }

        private void AddEnteredLibraryPath(ListBox folders, TextBox pathBox)
        {
            string path = pathBox.Text.Trim();
            if (path.Length == 0)
            {
                return;
            }
            if (!Path.IsPathRooted(path))
            {
                MessageBox.Show(
                    this,
                    "Enter a complete local or network path.",
                    "MVBar settings",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }
            AddLibraryPath(folders, path);
            pathBox.Clear();
        }

        private static void AddLibraryPath(ListBox folders, string path)
        {
            string normalized = path.Trim();
            string root = Path.GetPathRoot(normalized);
            if (!String.IsNullOrEmpty(root) && normalized.Length > root.Length)
            {
                normalized = normalized.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar);
            }
            for (int index = 0; index < folders.Items.Count; index++)
            {
                if (String.Equals(
                    folders.Items[index].ToString(),
                    normalized,
                    StringComparison.OrdinalIgnoreCase))
                {
                    folders.SelectedIndex = index;
                    return;
                }
            }
            folders.Items.Add(normalized);
            folders.SelectedIndex = folders.Items.Count - 1;
        }

        private void SaveSettings()
        {
            string listenHost;
            if (bindingModeBox.SelectedIndex == 0)
            {
                listenHost = "127.0.0.1";
            }
            else if (bindingModeBox.SelectedIndex == 1)
            {
                listenHost = "0.0.0.0";
            }
            else
            {
                listenHost = customAddressBox.Text.Trim();
            }

            if (!IsValidListenHost(listenHost))
            {
                MessageBox.Show(
                    this,
                    "Enter a valid IPv4 address for the network binding.",
                    "MVBar settings",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                customAddressBox.Focus();
                return;
            }

            List<string> musicDirectories =
                ReadLibraryDirectories(musicFoldersList);
            if (musicDirectories.Count == 0)
            {
                MessageBox.Show(
                    this,
                    "Add at least one music library folder.",
                    "MVBar settings",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }
            List<string> audiobookDirectories =
                ReadLibraryDirectories(audiobookFoldersList);

            Settings = new LauncherSettings(
                listenHost,
                Decimal.ToInt32(portBox.Value),
                musicDirectories,
                audiobookDirectories);
            DialogResult = DialogResult.OK;
            Close();
        }

        private static List<string> ReadLibraryDirectories(ListBox folders)
        {
            var result = new List<string>();
            for (int index = 0; index < folders.Items.Count; index++)
            {
                result.Add(folders.Items[index].ToString());
            }
            return result;
        }

        private static void AddDialogLabel(
            Control parent,
            string text,
            int x,
            int y)
        {
            var label = new Label();
            label.AutoSize = true;
            label.Location = new Point(x, y);
            label.Font = new Font("Segoe UI", 8.5F, FontStyle.Regular);
            label.ForeColor = Color.FromArgb(83, 94, 115);
            label.Text = text;
            parent.Controls.Add(label);
        }

        private static Button CreateDialogButton(
            string text,
            int x,
            int y,
            int width,
            Action action)
        {
            var button = new Button();
            button.Location = new Point(x, y);
            button.Size = new Size(width, 30);
            button.Font = new Font("Segoe UI", 9F);
            button.Text = text;
            button.UseVisualStyleBackColor = true;
            button.Click += delegate { action(); };
            return button;
        }

        private sealed class LibraryTabControls
        {
            internal readonly TabPage Page;
            internal readonly ListBox Folders;

            internal LibraryTabControls(
                TabPage page,
                ListBox folders)
            {
                Page = page;
                Folders = folders;
            }
        }
    }

    private sealed class ServiceLog : IDisposable
    {
        private readonly object sync = new object();
        private readonly StreamWriter writer;

        internal ServiceLog(string path)
        {
            writer = new StreamWriter(path, true, new UTF8Encoding(false));
            writer.AutoFlush = true;
            writer.WriteLine();
            writer.WriteLine("=== " + DateTime.Now.ToString("o") + " ===");
        }

        internal void Write(string stream, string text)
        {
            lock (sync)
            {
                writer.WriteLine(
                    DateTime.Now.ToString("HH:mm:ss.fff") + " [" + stream + "] " + text);
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                writer.Dispose();
            }
        }
    }

    private sealed class ToolResult
    {
        internal readonly int ExitCode;
        internal readonly string Output;
        internal readonly string Error;

        internal ToolResult(int exitCode, string output, string error)
        {
            ExitCode = exitCode;
            Output = output;
            Error = error;
        }
    }

    private sealed class SegmentStream : Stream
    {
        private readonly Stream source;
        private readonly long start;
        private readonly long length;
        private long position;

        internal SegmentStream(Stream source, long start, long length)
        {
            this.source = source;
            this.start = start;
            this.length = length;
            source.Seek(start, SeekOrigin.Begin);
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position
        {
            get { return position; }
            set { Seek(value, SeekOrigin.Begin); }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            long remaining = length - position;
            if (remaining <= 0)
            {
                return 0;
            }
            if (count > remaining)
            {
                count = (int)remaining;
            }
            source.Seek(start + position, SeekOrigin.Begin);
            int read = source.Read(buffer, offset, count);
            position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target;
            if (origin == SeekOrigin.Begin)
            {
                target = offset;
            }
            else if (origin == SeekOrigin.Current)
            {
                target = position + offset;
            }
            else
            {
                target = length + offset;
            }
            if (target < 0 || target > length)
            {
                throw new IOException("Attempted to seek outside the embedded payload.");
            }
            position = target;
            return position;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count)
        {
            throw new NotSupportedException();
        }
    }

    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    private enum JobObjectInfoType
    {
        ExtendedLimitInformation = 9
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        JobObjectInfoType informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
