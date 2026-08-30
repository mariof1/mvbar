#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef BUILD_ID
#define BUILD_ID "development"
#endif

#define FOOTER_MAGIC "MVBARLNX1"
#define FOOTER_MAGIC_LENGTH 9
#define FOOTER_LENGTH (8 + FOOTER_MAGIC_LENGTH)

static void die(const char *message) {
    fprintf(stderr, "MVBar: %s\n", message);
    exit(EXIT_FAILURE);
}

static void die_path(const char *message, const char *path) {
    fprintf(stderr, "MVBar: %s: %s (%s)\n", message, path, strerror(errno));
    exit(EXIT_FAILURE);
}

static void join_path(char *output, size_t output_size, const char *left, const char *right) {
    int written = snprintf(output, output_size, "%s/%s", left, right);
    if (written < 0 || (size_t)written >= output_size) die("A generated path is too long");
}

static void make_directories(const char *path, mode_t mode) {
    char buffer[PATH_MAX];
    size_t length = strlen(path);
    if (length == 0 || length >= sizeof(buffer)) die("Invalid data directory path");

    memcpy(buffer, path, length + 1);
    for (char *cursor = buffer + 1; *cursor; cursor++) {
        if (*cursor != '/') continue;
        *cursor = '\0';
        if (mkdir(buffer, mode) != 0 && errno != EEXIST) die_path("Cannot create directory", buffer);
        *cursor = '/';
    }
    if (mkdir(buffer, mode) != 0 && errno != EEXIST) die_path("Cannot create directory", buffer);
}

static int is_regular_file(const char *path) {
    struct stat info;
    return stat(path, &info) == 0 && S_ISREG(info.st_mode);
}

static void remove_temporary_directory(const char *path) {
    pid_t child = fork();
    if (child == 0) {
        execlp("rm", "rm", "-rf", "--", path, (char *)NULL);
        _exit(127);
    }
    if (child > 0) {
        int status;
        (void)waitpid(child, &status, 0);
    }
}

static uint64_t read_little_endian_u64(const unsigned char *bytes) {
    uint64_t value = 0;
    for (int index = 7; index >= 0; index--) value = (value << 8) | bytes[index];
    return value;
}

static int extract_payload(const char *executable, const char *destination) {
    int source = open(executable, O_RDONLY);
    if (source < 0) die_path("Cannot open the standalone executable", executable);

    off_t file_size = lseek(source, 0, SEEK_END);
    if (file_size < FOOTER_LENGTH) die("The standalone executable has no payload footer");

    unsigned char footer[FOOTER_LENGTH];
    ssize_t footer_read = pread(source, footer, sizeof(footer), file_size - FOOTER_LENGTH);
    if (footer_read != (ssize_t)sizeof(footer) ||
        memcmp(footer + 8, FOOTER_MAGIC, FOOTER_MAGIC_LENGTH) != 0) {
        close(source);
        die("The standalone executable payload is missing or damaged");
    }

    uint64_t payload_length = read_little_endian_u64(footer);
    if (payload_length == 0 || payload_length > (uint64_t)(file_size - FOOTER_LENGTH)) {
        close(source);
        die("The standalone executable contains an invalid payload length");
    }
    off_t payload_offset = file_size - FOOTER_LENGTH - (off_t)payload_length;

    int stream[2];
    if (pipe(stream) != 0) {
        close(source);
        die("Cannot create the extraction stream");
    }

    pid_t child = fork();
    if (child < 0) {
        close(stream[0]);
        close(stream[1]);
        close(source);
        die("Cannot start the payload extractor");
    }

    if (child == 0) {
        close(stream[1]);
        if (chdir(destination) != 0 || dup2(stream[0], STDIN_FILENO) < 0) _exit(126);
        close(stream[0]);
        execlp("tar", "tar", "-xzf", "-", (char *)NULL);
        _exit(127);
    }

    close(stream[0]);
    signal(SIGPIPE, SIG_IGN);
    unsigned char buffer[1024 * 1024];
    uint64_t remaining = payload_length;
    off_t position = payload_offset;
    int stream_failed = 0;

    while (remaining > 0 && !stream_failed) {
        size_t wanted = remaining < sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
        ssize_t count = pread(source, buffer, wanted, position);
        if (count <= 0) {
            stream_failed = 1;
            break;
        }
        size_t sent = 0;
        while (sent < (size_t)count) {
            ssize_t written = write(stream[1], buffer + sent, (size_t)count - sent);
            if (written < 0) {
                if (errno == EINTR) continue;
                stream_failed = 1;
                break;
            }
            sent += (size_t)written;
        }
        position += count;
        remaining -= (uint64_t)count;
    }

    close(stream[1]);
    close(source);
    int status = 0;
    if (waitpid(child, &status, 0) < 0) stream_failed = 1;
    return !stream_failed && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static void ensure_payload(const char *executable, const char *app_base, char *app_root, size_t app_root_size) {
    join_path(app_root, app_root_size, app_base, BUILD_ID);
    char marker[PATH_MAX];
    char script[PATH_MAX];
    join_path(marker, sizeof(marker), app_root, ".complete");
    join_path(script, sizeof(script), app_root, "app/mvbar.sh");
    if (is_regular_file(marker) && is_regular_file(script)) return;

    char temporary[PATH_MAX];
    int written = snprintf(temporary, sizeof(temporary), "%s/.%s.tmp.%ld", app_base, BUILD_ID, (long)getpid());
    if (written < 0 || (size_t)written >= sizeof(temporary)) die("The extraction path is too long");
    if (mkdir(temporary, 0700) != 0) die_path("Cannot create the extraction directory", temporary);

    printf("Extracting MVBar %s...\n", BUILD_ID);
    fflush(stdout);
    if (!extract_payload(executable, temporary)) {
        remove_temporary_directory(temporary);
        die("Payload extraction failed; install tar and gzip, then try again");
    }

    char temporary_script[PATH_MAX];
    char temporary_marker[PATH_MAX];
    join_path(temporary_script, sizeof(temporary_script), temporary, "app/mvbar.sh");
    join_path(temporary_marker, sizeof(temporary_marker), temporary, ".complete");
    if (!is_regular_file(temporary_script)) {
        remove_temporary_directory(temporary);
        die("The extracted payload is incomplete");
    }

    int marker_fd = open(temporary_marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (marker_fd < 0) {
        remove_temporary_directory(temporary);
        die_path("Cannot complete payload extraction", temporary_marker);
    }
    (void)write(marker_fd, BUILD_ID "\n", strlen(BUILD_ID) + 1);
    close(marker_fd);

    if (rename(temporary, app_root) != 0) {
        if (errno == EEXIST && is_regular_file(marker) && is_regular_file(script)) {
            remove_temporary_directory(temporary);
            return;
        }
        remove_temporary_directory(temporary);
        die_path("Cannot activate the extracted payload", app_root);
    }
}

static void absolute_path(const char *input, char *output, size_t output_size) {
    if (input[0] == '/') {
        if (snprintf(output, output_size, "%s", input) >= (int)output_size) die("The data path is too long");
        return;
    }
    char current[PATH_MAX];
    if (!getcwd(current, sizeof(current))) die("Cannot read the current directory");
    join_path(output, output_size, current, input);
}

int main(int argc, char **argv) {
    char executable[PATH_MAX];
    ssize_t executable_length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (executable_length < 0 || executable_length >= (ssize_t)sizeof(executable) - 1) {
        die("Cannot locate the running executable through /proc/self/exe");
    }
    executable[executable_length] = '\0';

    const char *configured_home = getenv("MVBAR_HOME");
    char default_home[PATH_MAX];
    if (!configured_home || configured_home[0] == '\0') {
        const char *xdg_home = getenv("XDG_DATA_HOME");
        if (xdg_home && xdg_home[0] != '\0') {
            join_path(default_home, sizeof(default_home), xdg_home, "mvbar");
        } else {
            const char *user_home = getenv("HOME");
            if (!user_home || user_home[0] == '\0') die("HOME and MVBAR_HOME are both unset");
            join_path(default_home, sizeof(default_home), user_home, ".local/share/mvbar");
        }
        configured_home = default_home;
    }

    char home_root[PATH_MAX];
    absolute_path(configured_home, home_root, sizeof(home_root));
    make_directories(home_root, 0700);

    char app_base[PATH_MAX];
    char app_root[PATH_MAX];
    char script[PATH_MAX];
    join_path(app_base, sizeof(app_base), home_root, "app");
    make_directories(app_base, 0700);
    ensure_payload(executable, app_base, app_root, sizeof(app_root));
    join_path(script, sizeof(script), app_root, "app/mvbar.sh");

    setenv("MVBAR_HOME", home_root, 1);
    setenv("MVBAR_APP_ROOT", app_root, 1);
    setenv("MVBAR_BUILD_ID", BUILD_ID, 1);
    setenv("MVBAR_EXECUTABLE", executable, 1);
    signal(SIGPIPE, SIG_DFL);

    char **shell_arguments = calloc((size_t)argc + 2, sizeof(char *));
    if (!shell_arguments) die("Cannot allocate launcher arguments");
    shell_arguments[0] = "sh";
    shell_arguments[1] = script;
    for (int index = 1; index < argc; index++) shell_arguments[index + 1] = argv[index];
    shell_arguments[argc + 1] = NULL;

    execv("/bin/sh", shell_arguments);
    die_path("Cannot start the MVBar controller", script);
    return EXIT_FAILURE;
}
