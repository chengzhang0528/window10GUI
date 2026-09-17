#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <stdio.h>

// The public entry point must work before any modern .NET runtime is installed.
// Let apphost perform normal framework resolution. Only its pre-Main missing
// runtime codes can enter setup; never retry an application/NDJSON failure.
#define FRAMEWORK_MISSING 0x80008096u
#define HOSTFXR_MISSING 0x80008083u
#define MAX_COMMAND 32768

static int append_arg(wchar_t *command, const wchar_t *arg) {
    size_t used = wcslen(command), slashes = 0;
    // Worst case: every character needs two backslashes plus delimiters.
    if (used + 2 * wcslen(arg) + 4 >= MAX_COMMAND) return 0;
    wchar_t *out = command + used;
    if (used) *out++ = L' ';
    *out++ = L'"';
    for (; *arg; arg++) {
        if (*arg == L'\\') { slashes++; continue; }
        if (*arg == L'"') {
            for (size_t i = 0; i < slashes * 2 + 1; i++) *out++ = L'\\';
        } else {
            for (size_t i = 0; i < slashes; i++) *out++ = L'\\';
        }
        slashes = 0;
        *out++ = *arg;
    }
    for (size_t i = 0; i < slashes * 2; i++) *out++ = L'\\';
    *out++ = L'"';
    *out = 0;
    return 1;
}

static DWORD run(const wchar_t *program, wchar_t *command, int setup) {
    STARTUPINFOW si = { .cb = sizeof(si) };
    PROCESS_INFORMATION pi = {0};
    HANDLE nullInput = INVALID_HANDLE_VALUE;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (setup) {
        SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
        nullInput = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
        if (nullInput == INVALID_HANDLE_VALUE) return 20;
        si.hStdInput = nullInput;
        // Setup must never consume queued requests or pollute JSON stdout.
        si.hStdOutput = si.hStdError;
    }
    BOOL created = CreateProcessW(program, command, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
    if (nullInput != INVALID_HANDLE_VALUE) CloseHandle(nullInput);
    if (!created) {
        fprintf(stderr, "DeskPilot: unable to start component (Windows error %lu).\n", GetLastError());
        return 20;
    }
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 20;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    return code;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t root[MAX_COMMAND], inner[MAX_COMMAND], command[MAX_COMMAND] = L"";
    DWORD length = GetModuleFileNameW(NULL, root, MAX_COMMAND);
    if (!length || length >= MAX_COMMAND - 1) return 20;
    wchar_t *separator = wcsrchr(root, L'\\');
    if (!separator) return 20;
    *separator = 0;
    if (wcslen(root) + 40 >= MAX_COMMAND) return 20;
    swprintf(inner, MAX_COMMAND, L"%ls\\app\\win-agent.exe", root);
    if (!append_arg(command, inner)) return 20;
    for (int i = 1; i < argc; i++) if (!append_arg(command, argv[i])) return 20;
    DWORD code = run(inner, command, 0);
    if (code != FRAMEWORK_MISSING && code != HOSTFXR_MISSING) return (int)code;

    wchar_t powershell[MAX_COMMAND], script[MAX_COMMAND];
    if (!GetSystemDirectoryW(powershell, MAX_COMMAND - 60)) return 20;
    wcscat(powershell, L"\\WindowsPowerShell\\v1.0\\powershell.exe");
    swprintf(script, MAX_COMMAND, L"%ls\\ensure-runtime.ps1", root);
    command[0] = 0;
    if (!append_arg(command, powershell) || !append_arg(command, L"-NoProfile") ||
        !append_arg(command, L"-NonInteractive") || !append_arg(command, L"-ExecutionPolicy") ||
        !append_arg(command, L"Bypass") || !append_arg(command, L"-File") || !append_arg(command, script)) return 20;
    fprintf(stderr, "DeskPilot: .NET 10 Desktop Runtime x64 is missing; preparing it from Microsoft. UAC may require user action.\n");
    code = run(powershell, command, 1);
    if (code != 0) return (int)code;
    command[0] = 0;
    if (!append_arg(command, inner)) return 20;
    for (int i = 1; i < argc; i++) if (!append_arg(command, argv[i])) return 20;
    // Exactly one retry, safe because missing-runtime apphost never ran Main.
    return (int)run(inner, command, 0);
}
