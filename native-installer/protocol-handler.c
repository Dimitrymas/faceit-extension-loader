#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <shellapi.h>
#include <strsafe.h>
#include <wchar.h>

#define PATH_CAPACITY 4096
#define LEGACY_DEEP_LINK_PREFIX L"faceit-mods://"
#define ADDONPORT_DEEP_LINK_PREFIX L"addonport://"

static BOOL path_exists(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static BOOL join_path(wchar_t *output, size_t capacity, const wchar_t *left, const wchar_t *right) {
  size_t length;
  if (FAILED(StringCchCopyW(output, capacity, left))) return FALSE;
  if (FAILED(StringCchLengthW(output, capacity, &length))) return FALSE;
  if (length > 0 && output[length - 1] != L'\\') {
    if (FAILED(StringCchCatW(output, capacity, L"\\"))) return FALSE;
  }
  return SUCCEEDED(StringCchCatW(output, capacity, right));
}

static int compare_version_names(const wchar_t *left, const wchar_t *right) {
  const wchar_t *left_cursor = left + 4;
  const wchar_t *right_cursor = right + 4;
  while (*left_cursor || *right_cursor) {
    wchar_t *left_end = NULL;
    wchar_t *right_end = NULL;
    unsigned long left_value = wcstoul(left_cursor, &left_end, 10);
    unsigned long right_value = wcstoul(right_cursor, &right_end, 10);
    left_cursor = left_end;
    right_cursor = right_end;
    if (left_value != right_value) return left_value > right_value ? 1 : -1;
    if (*left_cursor == L'.') left_cursor += 1;
    if (*right_cursor == L'.') right_cursor += 1;
    if ((!*left_cursor || *left_cursor < L'0' || *left_cursor > L'9')
        && (!*right_cursor || *right_cursor < L'0' || *right_cursor > L'9')) break;
  }
  return 0;
}

static BOOL find_faceit_launcher(wchar_t *output, size_t capacity) {
  wchar_t local_app_data[PATH_CAPACITY];
  wchar_t faceit_root[PATH_CAPACITY];
  wchar_t pattern[PATH_CAPACITY];
  wchar_t best_name[MAX_PATH] = L"";
  WIN32_FIND_DATAW data;
  HANDLE search;
  DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", local_app_data, PATH_CAPACITY);
  if (length == 0 || length >= PATH_CAPACITY) return FALSE;
  if (!join_path(faceit_root, PATH_CAPACITY, local_app_data, L"FACEIT")) return FALSE;
  if (join_path(output, capacity, faceit_root, L"FACEIT.exe") && path_exists(output)) return TRUE;
  if (!join_path(pattern, PATH_CAPACITY, faceit_root, L"app-*")) return FALSE;
  search = FindFirstFileW(pattern, &data);
  if (search == INVALID_HANDLE_VALUE) return FALSE;
  do {
    wchar_t candidate_root[PATH_CAPACITY];
    wchar_t candidate_exe[PATH_CAPACITY];
    if (!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || wcsncmp(data.cFileName, L"app-", 4) != 0) continue;
    if (!join_path(candidate_root, PATH_CAPACITY, faceit_root, data.cFileName)
        || !join_path(candidate_exe, PATH_CAPACITY, candidate_root, L"FACEIT.exe")
        || !path_exists(candidate_exe)) continue;
    if (!best_name[0] || compare_version_names(data.cFileName, best_name) > 0) {
      StringCchCopyW(best_name, MAX_PATH, data.cFileName);
    }
  } while (FindNextFileW(search, &data));
  FindClose(search);
  if (!best_name[0] || !join_path(pattern, PATH_CAPACITY, faceit_root, best_name)) return FALSE;
  return join_path(output, capacity, pattern, L"FACEIT.exe") && path_exists(output);
}

static BOOL valid_target(const wchar_t *value) {
  size_t length = wcslen(value);
  if (length == 0 || length > 64) return FALSE;
  for (size_t index = 0; index < length; index += 1) {
    wchar_t character = value[index];
    if ((character < L'a' || character > L'z')
        && (character < L'0' || character > L'9')
        && character != L'-') return FALSE;
  }
  return TRUE;
}

static BOOL valid_session_component(const wchar_t *value, size_t minimum, size_t maximum) {
  size_t length = wcslen(value);
  if (length < minimum || length > maximum) return FALSE;
  for (size_t index = 0; index < length; index += 1) {
    wchar_t character = value[index];
    if ((character < L'a' || character > L'z')
        && (character < L'A' || character > L'Z')
        && (character < L'0' || character > L'9')
        && character != L'-'
        && character != L'_') return FALSE;
  }
  return TRUE;
}

static BOOL valid_addonport_link(const wchar_t *value) {
  wchar_t session_id[65];
  const wchar_t *session;
  const wchar_t *separator;
  size_t session_length;
  const wchar_t *action;
  if (!value || wcsncmp(value, ADDONPORT_DEEP_LINK_PREFIX, wcslen(ADDONPORT_DEEP_LINK_PREFIX)) != 0) {
    return FALSE;
  }
  action = value + wcslen(ADDONPORT_DEEP_LINK_PREFIX);
  if (wcscmp(action, L"open") == 0) return TRUE;
  if (wcsncmp(action, L"install/", 8) == 0) return valid_target(action + 8);
  if (wcsncmp(action, L"launch/", 7) == 0) return valid_target(action + 7);
  if (wcsncmp(action, L"connect/", 8) != 0) return FALSE;
  session = action + 8;
  separator = wcschr(session, L'/');
  if (!separator || wcschr(separator + 1, L'/')) return FALSE;
  session_length = (size_t)(separator - session);
  if (session_length < 20 || session_length > 64) return FALSE;
  wmemcpy(session_id, session, session_length);
  session_id[session_length] = L'\0';
  return valid_session_component(session_id, 20, 64)
    && valid_session_component(separator + 1, 32, 128);
}

static BOOL valid_deep_link(const wchar_t *value) {
  const wchar_t *action;
  if (valid_addonport_link(value)) return TRUE;
  if (!value || wcsncmp(value, LEGACY_DEEP_LINK_PREFIX, wcslen(LEGACY_DEEP_LINK_PREFIX)) != 0) return FALSE;
  action = value + wcslen(LEGACY_DEEP_LINK_PREFIX);
  if (wcscmp(action, L"open") == 0) return TRUE;
  if (wcsncmp(action, L"install/", 8) == 0) return valid_target(action + 8);
  if (wcsncmp(action, L"launch/", 7) == 0) return valid_target(action + 7);
  return FALSE;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
  int argument_count = 0;
  wchar_t **arguments;
  wchar_t faceit_exe[PATH_CAPACITY];
  wchar_t launch_command[PATH_CAPACITY * 2];
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  (void)instance;
  (void)previous;
  (void)command_line;
  (void)show_command;

  arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  if (!arguments || argument_count != 2 || !valid_deep_link(arguments[1])) {
    if (arguments) LocalFree(arguments);
    return 2;
  }
  if (!find_faceit_launcher(faceit_exe, PATH_CAPACITY)
      || FAILED(StringCchPrintfW(launch_command, PATH_CAPACITY * 2, L"\"%s\" \"%s\"", faceit_exe, arguments[1]))) {
    LocalFree(arguments);
    return 3;
  }
  LocalFree(arguments);
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(faceit_exe, launch_command, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &process)) return 4;
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return 0;
}
