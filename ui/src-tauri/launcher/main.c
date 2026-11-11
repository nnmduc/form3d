#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    char exe_path[PATH_MAX];
    uint32_t size = sizeof(exe_path);
    if (_NSGetExecutablePath(exe_path, &size) != 0) {
        fprintf(stderr, "Failed to get executable path\n");
        return 1;
    }

    // Resolve symlinks
    char real_exe[PATH_MAX];
    if (realpath(exe_path, real_exe) == NULL) {
        strncpy(real_exe, exe_path, sizeof(real_exe) - 1);
        real_exe[sizeof(real_exe) - 1] = '\0';
    }

    char *last_slash = strrchr(real_exe, '/');
    if (!last_slash) {
        return 1;
    }
    *last_slash = '\0'; // Directory of executable (e.g. .../Contents/MacOS)

    char python_bin[PATH_MAX];
    char server_py[PATH_MAX];
    char python_home[PATH_MAX];
    char python_path[PATH_MAX * 2];

    snprintf(python_bin, sizeof(python_bin), "%s/../Resources/python/bin/python3", real_exe);
    snprintf(server_py, sizeof(server_py), "%s/../Resources/backend/server.py", real_exe);
    snprintf(python_home, sizeof(python_home), "%s/../Resources/python", real_exe);
    snprintf(python_path, sizeof(python_path),
             "%s/../Resources/backend:%s/../Resources/python/lib/python3.11/site-packages",
             real_exe, real_exe);

    // If bundled Python runtime exists in Resources/
    if (access(python_bin, X_OK) == 0 && access(server_py, R_OK) == 0) {
        setenv("PYTHONHOME", python_home, 1);
        setenv("PYTHONPATH", python_path, 1);
        setenv("PYTHONDONTWRITEBYTECODE", "1", 1);
        setenv("PYTHONUNBUFFERED", "1", 1);
        char *const args[] = {python_bin, "-B", server_py, NULL};
        execv(python_bin, args);
        perror("Failed to exec bundled python");
        return 1;
    }

    // Development fallback: check current working directory for .venv
    if (access(".venv/bin/python3", X_OK) == 0 && access("server.py", R_OK) == 0) {
        char *const args[] = {".venv/bin/python3", "server.py", NULL};
        execv(".venv/bin/python3", args);
        perror("Failed to exec .venv python");
        return 1;
    }

    // Check parent directory for .venv
    if (access("../.venv/bin/python3", X_OK) == 0 && access("../server.py", R_OK) == 0) {
        chdir("..");
        char *const args[] = {".venv/bin/python3", "server.py", NULL};
        execv(".venv/bin/python3", args);
        perror("Failed to exec parent .venv python");
        return 1;
    }

    fprintf(stderr, "Could not find bundled Python sidecar or local .venv\n");
    return 1;
}
