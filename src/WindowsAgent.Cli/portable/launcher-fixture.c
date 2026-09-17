// Test-only apphost stand-in. Never shipped in the portable package.
#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#include <stdlib.h>

int wmain(int argc, wchar_t **argv) {
    wchar_t marker[4096], counter[4096], failure[32];
    GetEnvironmentVariableW(L"DESKPILOT_TEST_MARKER", marker, 4096);
    GetEnvironmentVariableW(L"DESKPILOT_TEST_COUNTER", counter, 4096);
    FILE *calls = _wfopen(counter, L"ab");
    if (calls) { fputc('x', calls); fclose(calls); }
    if (argc > 1 && !wcscmp(argv[1], L"--business-failure")) return 7;
    if (GetFileAttributesW(marker) == INVALID_FILE_ATTRIBUTES) {
        DWORD code = 0x80008096u;
        if (GetEnvironmentVariableW(L"DESKPILOT_TEST_MISSING_CODE", failure, 32)) code = wcstoul(failure, NULL, 16);
        ExitProcess(code);
    }
    for (int i = 1; i < argc; i++) {
        char utf8[8192];
        WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, utf8, sizeof(utf8), NULL, NULL);
        printf("arg:%s\n", utf8);
    }
    char buffer[4096];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), stdin))) fwrite(buffer, 1, count, stdout);
    return 0;
}
