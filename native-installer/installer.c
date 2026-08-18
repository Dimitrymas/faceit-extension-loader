#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <strsafe.h>
#include <tlhelp32.h>
#include <uxtheme.h>
#include <stdint.h>
#include <stdio.h>
#include <wchar.h>

typedef struct PayloadEntry {
  WORD resource_id;
  const wchar_t *relative_path;
  uint64_t size;
} PayloadEntry;

#include "payload_manifest.h"

#define PATH_CAPACITY 4096
#define STATUS_CAPACITY 1024
#define WM_APP_STATUS (WM_APP + 1)
#define WM_APP_PROGRESS (WM_APP + 2)
#define WM_APP_DONE (WM_APP + 3)

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif

#define IDC_INSTALL 100
#define IDC_RESTORE 101
#define IDC_OPEN_FOLDER 103

typedef enum SetupAction {
  ACTION_INSTALL = 1,
  ACTION_RESTORE = 2
} SetupAction;

typedef enum UiState {
  UI_STATE_READY = 0,
  UI_STATE_WORKING = 1,
  UI_STATE_SUCCESS = 2,
  UI_STATE_ERROR = 3
} UiState;

typedef enum ButtonKind {
  BUTTON_PRIMARY = 1,
  BUTTON_SECONDARY = 2
} ButtonKind;

typedef struct ButtonState {
  ButtonKind kind;
  BOOL hot;
} ButtonState;

typedef struct TaskArgs {
  SetupAction action;
} TaskArgs;

static HWND g_window;
static HWND g_install;
static HWND g_restore;
static HWND g_open_folder;
static HFONT g_title_font;
static HFONT g_heading_font;
static HFONT g_body_font;
static HFONT g_small_font;
static HBRUSH g_background_brush;
static HICON g_icon;
static BOOL g_busy;
static BOOL g_silent;
static BOOL g_install_complete;
static BOOL g_faceit_detected;
static BOOL g_payload_installed;
static BOOL g_restore_available;
static BOOL g_high_contrast;
static UINT g_dpi = 96;
static int g_progress_value;
static UiState g_ui_state = UI_STATE_READY;
static SetupAction g_active_action = ACTION_INSTALL;
static SetupAction g_completed_action = ACTION_INSTALL;
static ButtonState g_install_button_state = { BUTTON_PRIMARY, FALSE };
static ButtonState g_restore_button_state = { BUTTON_SECONDARY, FALSE };
static ButtonState g_folder_button_state = { BUTTON_SECONDARY, FALSE };
static wchar_t g_status_text[STATUS_CAPACITY] = L"Ready to install.";
static wchar_t g_detail_text[STATUS_CAPACITY] = L"";
static wchar_t g_faceit_text[128] = L"Checking for FACEIT...";
static wchar_t g_last_error[STATUS_CAPACITY];
#ifdef FACEIT_INSTALLER_CAPTURE
static UINT g_capture_dpi_override;
#endif

static BOOL find_latest_faceit_exe(wchar_t *output, size_t capacity);

static void set_error(const wchar_t *message) {
  StringCchCopyW(g_last_error, STATUS_CAPACITY, message ? message : L"Unknown error");
}

static void set_error_from_win32(const wchar_t *context) {
  wchar_t detail[512] = L"";
  DWORD code = GetLastError();
  FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0, detail, 512, NULL);
  StringCchPrintfW(g_last_error, STATUS_CAPACITY, L"%s (Windows error %lu: %s)", context, code, detail);
}

static BOOL equals_argument(const wchar_t *left, const wchar_t *right) {
  return left && right && _wcsicmp(left, right) == 0;
}

static BOOL env_flag_enabled(const wchar_t *name) {
  wchar_t value[16] = L"";
  DWORD length = GetEnvironmentVariableW(name, value, 16);
  return length > 0 && (wcscmp(value, L"1") == 0 || _wcsicmp(value, L"true") == 0);
}

static BOOL path_exists(const wchar_t *path) {
  return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static BOOL directory_exists(const wchar_t *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static BOOL join_path(wchar_t *output, size_t capacity, const wchar_t *left, const wchar_t *right) {
  size_t length;
  if (FAILED(StringCchCopyW(output, capacity, left))) return FALSE;
  if (FAILED(StringCchLengthW(output, capacity, &length))) return FALSE;
  if (length > 0 && output[length - 1] != L'\\' && output[length - 1] != L'/') {
    if (FAILED(StringCchCatW(output, capacity, L"\\"))) return FALSE;
  }
  return SUCCEEDED(StringCchCatW(output, capacity, right));
}

static BOOL ensure_directory(const wchar_t *path) {
  wchar_t buffer[PATH_CAPACITY];
  size_t length;
  if (!path || FAILED(StringCchCopyW(buffer, PATH_CAPACITY, path))) return FALSE;
  if (FAILED(StringCchLengthW(buffer, PATH_CAPACITY, &length))) return FALSE;
  for (size_t index = 3; index < length; index += 1) {
    if (buffer[index] != L'\\' && buffer[index] != L'/') continue;
    wchar_t saved = buffer[index];
    buffer[index] = L'\0';
    if (!CreateDirectoryW(buffer, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return FALSE;
    buffer[index] = saved;
  }
  return CreateDirectoryW(buffer, NULL) || GetLastError() == ERROR_ALREADY_EXISTS;
}

static BOOL ensure_parent_directory(const wchar_t *file_path) {
  wchar_t parent[PATH_CAPACITY];
  wchar_t *separator;
  if (FAILED(StringCchCopyW(parent, PATH_CAPACITY, file_path))) return FALSE;
  separator = wcsrchr(parent, L'\\');
  if (!separator) separator = wcsrchr(parent, L'/');
  if (!separator) return TRUE;
  *separator = L'\0';
  return ensure_directory(parent);
}

static BOOL remove_directory_tree(const wchar_t *path) {
  wchar_t double_terminated[PATH_CAPACITY + 1];
  SHFILEOPSTRUCTW operation;
  if (!directory_exists(path)) return TRUE;
  ZeroMemory(double_terminated, sizeof(double_terminated));
  if (FAILED(StringCchCopyW(double_terminated, PATH_CAPACITY, path))) return FALSE;
  ZeroMemory(&operation, sizeof(operation));
  operation.wFunc = FO_DELETE;
  operation.pFrom = double_terminated;
  operation.fFlags = FOF_NO_UI | FOF_NOCONFIRMATION | FOF_SILENT;
  return SHFileOperationW(&operation) == 0 && !operation.fAnyOperationsAborted;
}

static void post_status(const wchar_t *message) {
  if (g_silent || !g_window) return;
  size_t bytes = (wcslen(message) + 1) * sizeof(wchar_t);
  wchar_t *copy = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!copy) return;
  CopyMemory(copy, message, bytes);
  PostMessageW(g_window, WM_APP_STATUS, 0, (LPARAM)copy);
}

static void post_progress(int value) {
  if (!g_silent && g_window) PostMessageW(g_window, WM_APP_PROGRESS, (WPARAM)value, 0);
}

static BOOL get_local_app_data(wchar_t *output, size_t capacity) {
  wchar_t override[PATH_CAPACITY];
  DWORD override_length = GetEnvironmentVariableW(L"FACEIT_MODS_LOCAL_APP_DATA", override, PATH_CAPACITY);
  if (override_length > 0 && override_length < PATH_CAPACITY) {
    return SUCCEEDED(StringCchCopyW(output, capacity, override));
  }
  return SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, SHGFP_TYPE_CURRENT, output));
}

static BOOL get_mods_root(wchar_t *output, size_t capacity) {
  wchar_t local_app_data[PATH_CAPACITY];
  if (!get_local_app_data(local_app_data, PATH_CAPACITY)) return FALSE;
  return join_path(output, capacity, local_app_data, L"FACEIT Mods");
}

static BOOL get_install_root(wchar_t *output, size_t capacity) {
  wchar_t override[PATH_CAPACITY];
  wchar_t mods_root[PATH_CAPACITY];
  DWORD override_length = GetEnvironmentVariableW(L"FACEIT_MODS_INSTALL_ROOT", override, PATH_CAPACITY);
  if (override_length > 0 && override_length < PATH_CAPACITY) {
    return SUCCEEDED(StringCchCopyW(output, capacity, override));
  }
  if (!get_mods_root(mods_root, PATH_CAPACITY)) return FALSE;
  return join_path(output, capacity, mods_root, L"current");
}

static BOOL get_faceit_root(wchar_t *output, size_t capacity) {
  wchar_t override[PATH_CAPACITY];
  wchar_t local_app_data[PATH_CAPACITY];
  DWORD override_length = GetEnvironmentVariableW(L"FACEIT_MODS_FACEIT_ROOT", override, PATH_CAPACITY);
  if (override_length > 0 && override_length < PATH_CAPACITY) {
    return SUCCEEDED(StringCchCopyW(output, capacity, override));
  }
  if (!get_local_app_data(local_app_data, PATH_CAPACITY)) return FALSE;
  return join_path(output, capacity, local_app_data, L"FACEIT");
}

static BOOL write_resource_file(const PayloadEntry *entry, const wchar_t *destination_root) {
  HRSRC resource;
  HGLOBAL loaded;
  const BYTE *data;
  DWORD size;
  HANDLE file;
  wchar_t destination[PATH_CAPACITY];
  DWORD offset = 0;

  resource = FindResourceW(NULL, MAKEINTRESOURCEW(entry->resource_id), RT_RCDATA);
  if (!resource) {
    set_error_from_win32(L"Could not find an embedded setup file");
    return FALSE;
  }
  loaded = LoadResource(NULL, resource);
  data = (const BYTE *)LockResource(loaded);
  size = SizeofResource(NULL, resource);
  if (!loaded || !data || (uint64_t)size != entry->size) {
    set_error(L"An embedded setup file failed its size check");
    return FALSE;
  }
  if (!join_path(destination, PATH_CAPACITY, destination_root, entry->relative_path)
      || !ensure_parent_directory(destination)) {
    set_error(L"Could not create the setup destination directory");
    return FALSE;
  }
  file = CreateFileW(destination, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    set_error_from_win32(L"Could not create an installed file");
    return FALSE;
  }
  while (offset < size) {
    DWORD written = 0;
    DWORD remaining = size - offset;
    DWORD chunk = remaining > 1024 * 1024 ? 1024 * 1024 : remaining;
    if (!WriteFile(file, data + offset, chunk, &written, NULL) || written != chunk) {
      CloseHandle(file);
      set_error_from_win32(L"Could not write an installed file");
      return FALSE;
    }
    offset += written;
  }
  CloseHandle(file);
  return TRUE;
}

static BOOL extract_payload(const wchar_t *destination_root) {
  int target_progress = 70;
  post_status(L"Preparing the local runtime...");
  post_progress(0);
  if (!remove_directory_tree(destination_root) || !ensure_directory(destination_root)) {
    set_error(L"Could not prepare the installation directory");
    return FALSE;
  }
  for (size_t index = 0; index < PAYLOAD_COUNT; index += 1) {
    if (!write_resource_file(&PAYLOAD[index], destination_root)) return FALSE;
    post_progress((int)(((index + 1) * target_progress) / PAYLOAD_COUNT));
  }
  return TRUE;
}

static BOOL is_legacy_payload_directory(const wchar_t *name) {
  if (!name || name[0] < L'0' || name[0] > L'9') return FALSE;
  for (const wchar_t *cursor = name; *cursor; cursor += 1) {
    wchar_t value = *cursor;
    if ((value >= L'0' && value <= L'9') || (value >= L'a' && value <= L'z')
        || (value >= L'A' && value <= L'Z') || value == L'.' || value == L'-') continue;
    return FALSE;
  }
  return TRUE;
}

static void cleanup_legacy_payload_directories(void) {
  wchar_t root[PATH_CAPACITY];
  wchar_t pattern[PATH_CAPACITY];
  WIN32_FIND_DATAW data;
  HANDLE search;
  if (GetEnvironmentVariableW(L"FACEIT_MODS_INSTALL_ROOT", NULL, 0) > 0) return;
  if (!get_mods_root(root, PATH_CAPACITY) || !join_path(pattern, PATH_CAPACITY, root, L"*")) return;
  search = FindFirstFileW(pattern, &data);
  if (search == INVALID_HANDLE_VALUE) return;
  do {
    wchar_t candidate[PATH_CAPACITY];
    if (!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        || !is_legacy_payload_directory(data.cFileName)
        || !join_path(candidate, PATH_CAPACITY, root, data.cFileName)) continue;
    remove_directory_tree(candidate);
  } while (FindNextFileW(search, &data));
  FindClose(search);
}

static BOOL faceit_is_running(void) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W entry;
  BOOL found = FALSE;
  if (snapshot == INVALID_HANDLE_VALUE) return FALSE;
  ZeroMemory(&entry, sizeof(entry));
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (_wcsicmp(entry.szExeFile, L"FACEIT.exe") == 0) {
        found = TRUE;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return found;
}

static DWORD run_hidden_process(wchar_t *command, const wchar_t *working_directory, HANDLE output) {
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  DWORD exit_code = ERROR_GEN_FAILURE;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  if (output && output != INVALID_HANDLE_VALUE) {
    startup.dwFlags |= STARTF_USESTDHANDLES;
    startup.hStdOutput = output;
    startup.hStdError = output;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  }
  if (!CreateProcessW(NULL, command, NULL, NULL, output && output != INVALID_HANDLE_VALUE, CREATE_NO_WINDOW,
                      NULL, working_directory, &startup, &process)) {
    set_error_from_win32(L"Could not start a required process");
    return GetLastError();
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return exit_code;
}

static DWORD run_taskkill(BOOL force) {
  wchar_t command[256];
  HANDLE null_output = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE | FILE_SHARE_READ, NULL,
                                   OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (force) StringCchCopyW(command, 256, L"taskkill.exe /F /IM FACEIT.exe /T");
  else StringCchCopyW(command, 256, L"taskkill.exe /IM FACEIT.exe /T");
  DWORD result = run_hidden_process(command, NULL, null_output);
  if (null_output != INVALID_HANDLE_VALUE) CloseHandle(null_output);
  return result;
}

static BOOL close_faceit(void) {
  if (env_flag_enabled(L"FACEIT_MODS_SKIP_CLOSE") || !faceit_is_running()) return TRUE;
  post_status(L"Closing the FACEIT desktop client...");
  run_taskkill(FALSE);
  for (int attempt = 0; attempt < 5 && faceit_is_running(); attempt += 1) Sleep(1000);
  if (!faceit_is_running()) return TRUE;
  run_taskkill(TRUE);
  for (int attempt = 0; attempt < 5 && faceit_is_running(); attempt += 1) Sleep(1000);
  if (faceit_is_running()) {
    set_error(L"FACEIT.exe is still running. Close it from Task Manager and try again.");
    return FALSE;
  }
  return TRUE;
}

static DWORD run_loader_command(SetupAction action, const wchar_t *install_root, const wchar_t *faceit_root) {
  wchar_t faceit_exe[PATH_CAPACITY];
  wchar_t script_path[PATH_CAPACITY];
  wchar_t log_path[PATH_CAPACITY];
  wchar_t command[PATH_CAPACITY * 3];
  wchar_t previous_run_as_node[32];
  HANDLE log;
  DWORD result;
  DWORD runtime_override = GetEnvironmentVariableW(L"FACEIT_MODS_RUNTIME_EXE", faceit_exe, PATH_CAPACITY);
  DWORD previous_length = GetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", previous_run_as_node, 32);
  if ((runtime_override == 0 && !find_latest_faceit_exe(faceit_exe, PATH_CAPACITY))
      || runtime_override >= PATH_CAPACITY) {
    set_error(L"FACEIT.exe was not found for the embedded setup runtime");
    return ERROR_FILE_NOT_FOUND;
  }
  if (!join_path(script_path, PATH_CAPACITY, install_root, L"bin\\faceit-extension-loader.js")
      || !join_path(log_path, PATH_CAPACITY, install_root, L"setup.log")) {
    set_error(L"The setup path is too long");
    return ERROR_BUFFER_OVERFLOW;
  }
  StringCchPrintfW(command, PATH_CAPACITY * 3, L"\"%s\" \"%s\" %s \"%s\" --json",
                   faceit_exe, script_path, action == ACTION_RESTORE ? L"restore" : L"patch", faceit_root);
  log = CreateFileW(log_path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL, NULL);
  if (log == INVALID_HANDLE_VALUE) {
    set_error_from_win32(L"Could not create setup.log");
    return GetLastError();
  }
  SetHandleInformation(log, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1");
  result = run_hidden_process(command, install_root, log);
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", previous_length > 0 && previous_length < 32
                          ? previous_run_as_node : NULL);
  CloseHandle(log);
  if (result != 0 && g_last_error[0] == L'\0') {
    StringCchPrintfW(g_last_error, STATUS_CAPACITY, L"The loader exited with code %lu. See setup.log for details.", result);
  }
  return result;
}

static void set_install_state_marker(BOOL installed) {
  wchar_t mods_root[PATH_CAPACITY];
  wchar_t marker[PATH_CAPACITY];
  HANDLE file;
  DWORD written = 0;
  const char contents[] = "installed\n";
  if (!get_mods_root(mods_root, PATH_CAPACITY) || !ensure_directory(mods_root)) return;
  if (!join_path(marker, PATH_CAPACITY, mods_root, L"installed.marker")) return;
  if (!installed) {
    DeleteFileW(marker);
    return;
  }
  file = CreateFileW(marker, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return;
  WriteFile(file, contents, (DWORD)(sizeof(contents) - 1), &written, NULL);
  CloseHandle(file);
}

static int perform_setup(SetupAction action) {
  wchar_t install_root[PATH_CAPACITY];
  wchar_t faceit_root[PATH_CAPACITY];
  g_last_error[0] = L'\0';
  if (!get_install_root(install_root, PATH_CAPACITY) || !get_faceit_root(faceit_root, PATH_CAPACITY)) {
    set_error(L"Could not resolve the current user's application folders");
    return 10;
  }
  if (!directory_exists(faceit_root)) {
    set_error(L"The FACEIT installation was not found for the current Windows user");
    return 11;
  }
  if (!extract_payload(install_root)) return 12;
  post_progress(75);
  if (!close_faceit()) return 13;
  post_status(action == ACTION_RESTORE ? L"Restoring the original FACEIT client..." : L"Patching the current FACEIT client...");
  post_progress(85);
  if (run_loader_command(action, install_root, faceit_root) != 0) return 14;
  cleanup_legacy_payload_directories();
  set_install_state_marker(action == ACTION_INSTALL);
  if (action == ACTION_RESTORE) {
    RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\faceit-mods");
  }
  post_progress(100);
  post_status(action == ACTION_RESTORE ? L"FACEIT was restored." : L"FACEIT Mods is installed.");
  return 0;
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

static BOOL find_latest_faceit_exe(wchar_t *output, size_t capacity) {
  wchar_t root[PATH_CAPACITY];
  wchar_t pattern[PATH_CAPACITY];
  wchar_t best_name[MAX_PATH] = L"";
  WIN32_FIND_DATAW data;
  HANDLE search;
  if (!get_faceit_root(root, PATH_CAPACITY) || !join_path(pattern, PATH_CAPACITY, root, L"app-*")) return FALSE;
  search = FindFirstFileW(pattern, &data);
  if (search == INVALID_HANDLE_VALUE) return FALSE;
  do {
    wchar_t candidate_dir[PATH_CAPACITY];
    wchar_t candidate_exe[PATH_CAPACITY];
    if (!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || wcsncmp(data.cFileName, L"app-", 4) != 0) continue;
    if (!join_path(candidate_dir, PATH_CAPACITY, root, data.cFileName)
        || !join_path(candidate_exe, PATH_CAPACITY, candidate_dir, L"FACEIT.exe")
        || !path_exists(candidate_exe)) continue;
    if (!best_name[0] || compare_version_names(data.cFileName, best_name) > 0) {
      StringCchCopyW(best_name, MAX_PATH, data.cFileName);
    }
  } while (FindNextFileW(search, &data));
  FindClose(search);
  if (!best_name[0]) return FALSE;
  if (!join_path(pattern, PATH_CAPACITY, root, best_name)) return FALSE;
  return join_path(output, capacity, pattern, L"FACEIT.exe");
}

static BOOL launch_faceit(void) {
  wchar_t executable[PATH_CAPACITY];
  HINSTANCE result;
  if (!find_latest_faceit_exe(executable, PATH_CAPACITY)) {
    set_error(L"FACEIT.exe was not found in the latest app directory");
    return FALSE;
  }
  result = ShellExecuteW(NULL, L"open", executable, NULL, NULL, SW_SHOWNORMAL);
  if ((INT_PTR)result <= 32) {
    set_error(L"Windows could not launch FACEIT.exe");
    return FALSE;
  }
  return TRUE;
}

static void open_install_folder(void) {
  wchar_t root[PATH_CAPACITY];
  if (!get_install_root(root, PATH_CAPACITY)) return;
  ensure_directory(root);
  ShellExecuteW(NULL, L"open", root, NULL, NULL, SW_SHOWNORMAL);
}

static int scale_value(int value) {
  return MulDiv(value, (int)g_dpi, 96);
}

static BOOL high_contrast_enabled(void) {
  HIGHCONTRASTW contrast;
  ZeroMemory(&contrast, sizeof(contrast));
  contrast.cbSize = sizeof(contrast);
  return SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(contrast), &contrast, 0)
    && (contrast.dwFlags & HCF_HIGHCONTRASTON) != 0;
}

static COLORREF color_background(void) {
  return g_high_contrast ? GetSysColor(COLOR_WINDOW) : RGB(18, 18, 18);
}

static COLORREF color_text(void) {
  return g_high_contrast ? GetSysColor(COLOR_WINDOWTEXT) : RGB(246, 246, 246);
}

static COLORREF color_muted(void) {
  return g_high_contrast ? GetSysColor(COLOR_WINDOWTEXT) : RGB(166, 166, 166);
}

static COLORREF color_subtle(void) {
  return g_high_contrast ? GetSysColor(COLOR_GRAYTEXT) : RGB(126, 126, 126);
}

static COLORREF color_accent(void) {
  return g_high_contrast ? GetSysColor(COLOR_HIGHLIGHT) : RGB(255, 85, 0);
}

static void delete_fonts(void) {
  if (g_title_font) DeleteObject(g_title_font);
  if (g_heading_font) DeleteObject(g_heading_font);
  if (g_body_font) DeleteObject(g_body_font);
  if (g_small_font) DeleteObject(g_small_font);
  g_title_font = NULL;
  g_heading_font = NULL;
  g_body_font = NULL;
  g_small_font = NULL;
}

static void create_fonts(void) {
  delete_fonts();
  g_title_font = CreateFontW(-scale_value(18), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Variable Display");
  g_heading_font = CreateFontW(-scale_value(24), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                               OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                               DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Variable Display");
  g_body_font = CreateFontW(-scale_value(14), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Variable Text");
  g_small_font = CreateFontW(-scale_value(12), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI Variable Text");
}

static BOOL install_folder_exists(void) {
  wchar_t root[PATH_CAPACITY];
  return get_install_root(root, PATH_CAPACITY) && directory_exists(root);
}

static BOOL restore_backup_exists(void) {
  wchar_t root[PATH_CAPACITY];
  wchar_t pattern[PATH_CAPACITY];
  WIN32_FIND_DATAW data;
  HANDLE search;
  BOOL found = FALSE;
  if (!get_faceit_root(root, PATH_CAPACITY) || !join_path(pattern, PATH_CAPACITY, root, L"app-*")) return FALSE;
  search = FindFirstFileW(pattern, &data);
  if (search == INVALID_HANDLE_VALUE) return FALSE;
  do {
    wchar_t candidate[PATH_CAPACITY];
    wchar_t resources[PATH_CAPACITY];
    if (!(data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        || !join_path(candidate, PATH_CAPACITY, root, data.cFileName)
        || !join_path(resources, PATH_CAPACITY, candidate, L"resources")
        || !join_path(candidate, PATH_CAPACITY, resources, L"app.asar.orig")) continue;
    if (path_exists(candidate)) {
      found = TRUE;
      break;
    }
  } while (FindNextFileW(search, &data));
  FindClose(search);
  return found;
}

static void set_button_texts(void) {
  const wchar_t *primary_text;
  if (g_busy) primary_text = L"Working...";
  else if (g_ui_state == UI_STATE_SUCCESS && g_completed_action == ACTION_INSTALL) primary_text = L"Open FACEIT";
  else if (g_ui_state == UI_STATE_SUCCESS && g_completed_action == ACTION_RESTORE) primary_text = L"Close";
  else if (g_ui_state == UI_STATE_ERROR) primary_text = L"Try again";
  else primary_text = g_payload_installed ? L"Update" : L"Install";
  SetWindowTextW(g_install, primary_text);
  SetWindowTextW(g_restore, L"Restore FACEIT");
  SetWindowTextW(g_open_folder, L"Open files");
}

static void set_controls_enabled(BOOL enabled) {
  EnableWindow(g_install, enabled && g_faceit_detected);
  EnableWindow(g_restore, enabled && g_restore_available);
  EnableWindow(g_open_folder, enabled && install_folder_exists());
  if (g_window) InvalidateRect(g_window, NULL, FALSE);
}

static void initialize_preflight(void) {
  wchar_t executable[PATH_CAPACITY];
  wchar_t parent[PATH_CAPACITY];
  wchar_t marker_path[PATH_CAPACITY];
  wchar_t mods_root[PATH_CAPACITY];
  g_faceit_detected = find_latest_faceit_exe(executable, PATH_CAPACITY);
  if (g_faceit_detected && SUCCEEDED(StringCchCopyW(parent, PATH_CAPACITY, executable))) {
    wchar_t *separator = wcsrchr(parent, L'\\');
    if (separator) {
      *separator = L'\0';
      separator = wcsrchr(parent, L'\\');
    }
    if (separator && wcsncmp(separator + 1, L"app-", 4) == 0) {
      StringCchPrintfW(g_faceit_text, 128, L"FACEIT %s detected", separator + 5);
    } else {
      StringCchCopyW(g_faceit_text, 128, L"FACEIT desktop client detected");
    }
  } else {
    StringCchCopyW(g_faceit_text, 128, L"FACEIT desktop client not found");
  }
  g_payload_installed = get_mods_root(mods_root, PATH_CAPACITY)
    && join_path(marker_path, PATH_CAPACITY, mods_root, L"installed.marker")
    && path_exists(marker_path);
  g_restore_available = restore_backup_exists();
  g_ui_state = UI_STATE_READY;
  g_progress_value = 0;
  g_install_complete = FALSE;
  if (!g_faceit_detected) {
    StringCchCopyW(g_status_text, STATUS_CAPACITY, L"Install FACEIT for this Windows account, then run setup again.");
    StringCchCopyW(g_detail_text, STATUS_CAPACITY, L"Setup did not find a standard FACEIT app-* directory.");
  } else if (g_payload_installed) {
    StringCchCopyW(g_status_text, STATUS_CAPACITY, L"Extension support is already installed and ready to update.");
    StringCchCopyW(g_detail_text, STATUS_CAPACITY, L"FACEIT closes briefly while setup applies the local patch.");
  } else {
    StringCchCopyW(g_status_text, STATUS_CAPACITY, L"Ready to install extension support.");
    StringCchCopyW(g_detail_text, STATUS_CAPACITY, L"FACEIT closes briefly while setup applies the local patch.");
  }
  set_button_texts();
  set_controls_enabled(TRUE);
}

static DWORD WINAPI setup_thread(LPVOID parameter) {
  TaskArgs *task = (TaskArgs *)parameter;
  SetupAction action = task->action;
  HeapFree(GetProcessHeap(), 0, task);
  int result = perform_setup(action);
  PostMessageW(g_window, WM_APP_DONE, (WPARAM)result, (LPARAM)action);
  return 0;
}

static void show_inline_error(const wchar_t *message) {
  g_busy = FALSE;
  g_ui_state = UI_STATE_ERROR;
  StringCchCopyW(g_status_text, STATUS_CAPACITY, L"Setup could not finish.");
  StringCchCopyW(g_detail_text, STATUS_CAPACITY, message && message[0] ? message : L"Open setup files for the detailed log.");
  set_button_texts();
  set_controls_enabled(TRUE);
}

static void start_task(SetupAction action) {
  TaskArgs *task;
  HANDLE thread;
  if (g_busy) return;
  g_busy = TRUE;
  g_install_complete = FALSE;
  g_active_action = action;
  g_ui_state = UI_STATE_WORKING;
  g_progress_value = 0;
  StringCchCopyW(g_status_text, STATUS_CAPACITY,
                 action == ACTION_RESTORE ? L"Preparing to restore FACEIT..." : L"Preparing extension support...");
  StringCchCopyW(g_detail_text, STATUS_CAPACITY, L"Keep this window open until the operation is complete.");
  set_button_texts();
  set_controls_enabled(FALSE);
  task = (TaskArgs *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(TaskArgs));
  if (!task) {
    show_inline_error(L"Windows could not allocate the setup task.");
    return;
  }
  task->action = action;
  thread = CreateThread(NULL, 0, setup_thread, task, 0, NULL);
  if (!thread) {
    HeapFree(GetProcessHeap(), 0, task);
    show_inline_error(L"Windows could not start the setup task.");
    return;
  }
  CloseHandle(thread);
}

static BOOL confirm_restore(HWND window) {
  TASKDIALOG_BUTTON restore_button = { 1001, L"Restore FACEIT" };
  TASKDIALOGCONFIG dialog;
  int selected = 0;
  ZeroMemory(&dialog, sizeof(dialog));
  dialog.cbSize = sizeof(dialog);
  dialog.hwndParent = window;
  dialog.dwFlags = TDF_SIZE_TO_CONTENT | TDF_POSITION_RELATIVE_TO_WINDOW;
  dialog.dwCommonButtons = TDCBF_CANCEL_BUTTON;
  dialog.pszWindowTitle = APP_TITLE;
  dialog.pszMainIcon = TD_WARNING_ICON;
  dialog.pszMainInstruction = L"Restore the original FACEIT client?";
  dialog.pszContent = L"Extension support will stop loading until you install it again. Your extension data is kept.";
  dialog.cButtons = 1;
  dialog.pButtons = &restore_button;
  dialog.nDefaultButton = IDCANCEL;
  return SUCCEEDED(TaskDialogIndirect(&dialog, &selected, NULL, NULL)) && selected == 1001;
}

static LRESULT CALLBACK button_proc(HWND button, UINT message, WPARAM w_param, LPARAM l_param,
                                    UINT_PTR subclass_id, DWORD_PTR reference) {
  ButtonState *state = (ButtonState *)reference;
  (void)subclass_id;
  switch (message) {
    case WM_MOUSEMOVE:
      if (!state->hot) {
        TRACKMOUSEEVENT tracking = { sizeof(tracking), TME_LEAVE, button, 0 };
        state->hot = TRUE;
        TrackMouseEvent(&tracking);
        InvalidateRect(button, NULL, FALSE);
      }
      break;
    case WM_MOUSELEAVE:
      state->hot = FALSE;
      InvalidateRect(button, NULL, FALSE);
      break;
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
    case WM_ENABLE:
      InvalidateRect(button, NULL, FALSE);
      break;
    case WM_NCDESTROY:
      RemoveWindowSubclass(button, button_proc, 1);
      break;
  }
  return DefSubclassProc(button, message, w_param, l_param);
}

static void draw_button(const DRAWITEMSTRUCT *item) {
  ButtonState *state = (ButtonState *)GetWindowLongPtrW(item->hwndItem, GWLP_USERDATA);
  BOOL disabled = !IsWindowEnabled(item->hwndItem);
  BOOL selected = (item->itemState & ODS_SELECTED) != 0;
  BOOL primary = state && state->kind == BUTTON_PRIMARY;
  COLORREF background;
  COLORREF border;
  COLORREF foreground;
  wchar_t text[128];
  RECT text_rect = item->rcItem;
  int radius = scale_value(8);
  if (g_high_contrast) {
    background = primary && !disabled ? GetSysColor(COLOR_HIGHLIGHT) : GetSysColor(COLOR_WINDOW);
    border = disabled ? GetSysColor(COLOR_GRAYTEXT) : GetSysColor(COLOR_WINDOWTEXT);
    foreground = primary && !disabled ? GetSysColor(COLOR_HIGHLIGHTTEXT)
                                      : (disabled ? GetSysColor(COLOR_GRAYTEXT) : GetSysColor(COLOR_WINDOWTEXT));
  } else if (disabled) {
    background = RGB(31, 31, 31);
    border = RGB(50, 50, 50);
    foreground = RGB(105, 105, 105);
  } else if (primary) {
    background = selected ? RGB(222, 72, 0) : (state->hot ? RGB(255, 105, 31) : RGB(255, 85, 0));
    border = background;
    foreground = RGB(18, 18, 18);
  } else {
    background = selected ? RGB(39, 39, 39) : (state->hot ? RGB(34, 34, 34) : RGB(24, 24, 24));
    border = state->hot ? RGB(92, 92, 92) : RGB(62, 62, 62);
    foreground = RGB(238, 238, 238);
  }
  HBRUSH brush = CreateSolidBrush(background);
  HPEN pen = CreatePen(PS_SOLID, max(1, scale_value(1)), border);
  HGDIOBJ old_brush = SelectObject(item->hDC, brush);
  HGDIOBJ old_pen = SelectObject(item->hDC, pen);
  SetBkMode(item->hDC, TRANSPARENT);
  RoundRect(item->hDC, item->rcItem.left, item->rcItem.top, item->rcItem.right, item->rcItem.bottom, radius, radius);
  SelectObject(item->hDC, old_brush);
  SelectObject(item->hDC, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
  if (selected) OffsetRect(&text_rect, 0, scale_value(1));
  GetWindowTextW(item->hwndItem, text, 128);
  SetTextColor(item->hDC, foreground);
  SelectObject(item->hDC, g_body_font);
  DrawTextW(item->hDC, text, -1, &text_rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  if ((item->itemState & ODS_FOCUS) && !disabled) {
    RECT focus = item->rcItem;
    InflateRect(&focus, -scale_value(3), -scale_value(3));
    HPEN focus_pen = CreatePen(PS_SOLID, max(1, scale_value(1)), primary ? RGB(18, 18, 18) : color_accent());
    HGDIOBJ previous_pen = SelectObject(item->hDC, focus_pen);
    HGDIOBJ previous_brush = SelectObject(item->hDC, GetStockObject(NULL_BRUSH));
    RoundRect(item->hDC, focus.left, focus.top, focus.right, focus.bottom, radius - 2, radius - 2);
    SelectObject(item->hDC, previous_brush);
    SelectObject(item->hDC, previous_pen);
    DeleteObject(focus_pen);
  }
}

static HWND create_button(HWND parent, int id, const wchar_t *text, ButtonState *state) {
  HWND button = CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
                                0, 0, 1, 1, parent, (HMENU)(INT_PTR)id, GetModuleHandleW(NULL), NULL);
  SetWindowLongPtrW(button, GWLP_USERDATA, (LONG_PTR)state);
  SetWindowSubclass(button, button_proc, 1, (DWORD_PTR)state);
  SendMessageW(button, WM_SETFONT, (WPARAM)g_body_font, TRUE);
  return button;
}

static void layout_controls(HWND window) {
  RECT client;
  int top;
  int height = scale_value(40);
  GetClientRect(window, &client);
  top = client.bottom - scale_value(59);
  SetWindowPos(g_restore, NULL, scale_value(32), top, scale_value(128), height, SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowPos(g_open_folder, NULL, scale_value(172), top, scale_value(110), height, SWP_NOZORDER | SWP_NOACTIVATE);
  SetWindowPos(g_install, NULL, client.right - scale_value(32 + 156), top, scale_value(156), height,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

static void create_controls(HWND window) {
  g_restore = create_button(window, IDC_RESTORE, L"Restore FACEIT", &g_restore_button_state);
  g_open_folder = create_button(window, IDC_OPEN_FOLDER, L"Open files", &g_folder_button_state);
  g_install = create_button(window, IDC_INSTALL, L"Install", &g_install_button_state);
  SendMessageW(window, DM_SETDEFID, IDC_INSTALL, 0);
  layout_controls(window);
  initialize_preflight();
}

static const wchar_t *heading_text(void) {
  if (g_ui_state == UI_STATE_WORKING) {
    return g_active_action == ACTION_RESTORE ? L"Restoring FACEIT" : L"Installing extension support";
  }
  if (g_ui_state == UI_STATE_SUCCESS) {
    return g_completed_action == ACTION_RESTORE ? L"FACEIT restored" : L"Installation complete";
  }
  if (g_ui_state == UI_STATE_ERROR) return L"Setup needs attention";
  return L"Install extensions for FACEIT";
}

static const wchar_t *body_text(void) {
  if (g_ui_state == UI_STATE_WORKING) return L"Setup is updating the local desktop client. This usually takes only a few seconds.";
  if (g_ui_state == UI_STATE_SUCCESS) {
    return g_completed_action == ACTION_RESTORE
      ? L"The verified original client files are active again."
      : L"Open FACEIT and use Mods in the right sidebar.";
  }
  if (g_ui_state == UI_STATE_ERROR) return L"Review the message below, then try the operation again.";
  return L"Adds support for compatible browser extensions to the desktop client.";
}

static COLORREF state_color(void) {
  if (g_high_contrast) return GetSysColor(COLOR_HIGHLIGHT);
  if (g_ui_state == UI_STATE_ERROR || !g_faceit_detected) return RGB(255, 99, 99);
  if (g_ui_state == UI_STATE_SUCCESS) return RGB(72, 196, 132);
  if (g_ui_state == UI_STATE_WORKING) return color_accent();
  return RGB(72, 196, 132);
}

static void draw_text_block(HDC dc, const wchar_t *text, HFONT font, COLORREF color, RECT rectangle, UINT flags) {
  HGDIOBJ previous = SelectObject(dc, font);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, color);
  DrawTextW(dc, text, -1, &rectangle, flags | DT_NOPREFIX);
  SelectObject(dc, previous);
}

static void render_window(HWND window, HDC dc) {
  RECT client;
  GetClientRect(window, &client);
  HDC memory = CreateCompatibleDC(dc);
  HBITMAP bitmap = CreateCompatibleBitmap(dc, client.right, client.bottom);
  HGDIOBJ previous_bitmap = SelectObject(memory, bitmap);
  HBRUSH background = CreateSolidBrush(color_background());
  FillRect(memory, &client, background);
  DeleteObject(background);

  if (g_icon) DrawIconEx(memory, scale_value(32), scale_value(23), g_icon, scale_value(48), scale_value(48), 0, NULL, DI_NORMAL);
  RECT title = { scale_value(94), scale_value(24), client.right - scale_value(32), scale_value(51) };
  draw_text_block(memory, L"FACEIT Extension Loader", g_title_font, color_text(), title,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
  wchar_t version[160];
  StringCchPrintfW(version, 160, L"Windows setup %s  /  Unofficial beta", APP_VERSION);
  RECT version_rect = { scale_value(94), scale_value(51), client.right - scale_value(32), scale_value(72) };
  draw_text_block(memory, version, g_small_font, color_subtle(), version_rect,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

  HBRUSH divider_brush = CreateSolidBrush(g_high_contrast ? GetSysColor(COLOR_WINDOWTEXT) : RGB(43, 43, 43));
  RECT header_divider = { scale_value(32), scale_value(93), client.right - scale_value(32), scale_value(94) };
  FillRect(memory, &header_divider, divider_brush);

  RECT heading = { scale_value(32), scale_value(119), client.right - scale_value(32), scale_value(153) };
  draw_text_block(memory, heading_text(), g_heading_font, color_text(), heading,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
  RECT body = { scale_value(32), scale_value(158), client.right - scale_value(32), scale_value(202) };
  draw_text_block(memory, body_text(), g_body_font, color_muted(), body,
                  DT_LEFT | DT_TOP | DT_WORDBREAK | DT_END_ELLIPSIS);

  int dot_size = scale_value(8);
  int dot_top = scale_value(216);
  HBRUSH dot_brush = CreateSolidBrush(state_color());
  HGDIOBJ previous_brush = SelectObject(memory, dot_brush);
  HGDIOBJ previous_pen = SelectObject(memory, GetStockObject(NULL_PEN));
  Ellipse(memory, scale_value(32), dot_top, scale_value(32) + dot_size, dot_top + dot_size);
  SelectObject(memory, previous_pen);
  SelectObject(memory, previous_brush);
  DeleteObject(dot_brush);
  RECT detection = { scale_value(50), scale_value(208), client.right - scale_value(32), scale_value(232) };
  draw_text_block(memory, g_faceit_text, g_body_font, color_text(), detection,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

  if (g_ui_state == UI_STATE_WORKING) {
    RECT progress_track = { scale_value(32), scale_value(244), client.right - scale_value(32), scale_value(248) };
    HBRUSH track_brush = CreateSolidBrush(g_high_contrast ? GetSysColor(COLOR_GRAYTEXT) : RGB(48, 48, 48));
    FillRect(memory, &progress_track, track_brush);
    DeleteObject(track_brush);
    RECT progress_fill = progress_track;
    progress_fill.right = progress_fill.left
      + (int)(((int64_t)(progress_track.right - progress_track.left) * min(g_progress_value, 100)) / 100);
    HBRUSH progress_brush = CreateSolidBrush(color_accent());
    FillRect(memory, &progress_fill, progress_brush);
    DeleteObject(progress_brush);
  }

  RECT status = { scale_value(32), scale_value(266), client.right - scale_value(32), scale_value(289) };
  draw_text_block(memory, g_status_text, g_body_font, color_text(), status,
                  DT_LEFT | DT_TOP | DT_SINGLELINE | DT_END_ELLIPSIS);
  RECT detail = { scale_value(32), scale_value(291), client.right - scale_value(32), scale_value(329) };
  draw_text_block(memory, g_detail_text, g_small_font, color_muted(), detail,
                  DT_LEFT | DT_TOP | DT_WORDBREAK | DT_END_ELLIPSIS);
  RECT boundary = { scale_value(32), scale_value(327), client.right - scale_value(32), scale_value(347) };
  draw_text_block(memory, L"Current user only. No administrator access. Anti-Cheat is not modified.",
                  g_small_font, color_subtle(), boundary,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);

  RECT footer_divider = { scale_value(32), client.bottom - scale_value(78), client.right - scale_value(32),
                          client.bottom - scale_value(77) };
  FillRect(memory, &footer_divider, divider_brush);
  DeleteObject(divider_brush);
  BitBlt(dc, 0, 0, client.right, client.bottom, memory, 0, 0, SRCCOPY);
  SelectObject(memory, previous_bitmap);
  DeleteObject(bitmap);
  DeleteDC(memory);
}

#ifdef FACEIT_INSTALLER_CAPTURE
static void configure_preview_state(void) {
  wchar_t state[32] = L"";
  DWORD length = GetEnvironmentVariableW(L"FACEIT_MODS_CAPTURE_STATE", state, 32);
  if (length == 0 || length >= 32 || _wcsicmp(state, L"ready") == 0) return;
  if (_wcsicmp(state, L"working") == 0) {
    g_busy = TRUE;
    g_active_action = ACTION_INSTALL;
    g_ui_state = UI_STATE_WORKING;
    g_progress_value = 58;
    StringCchCopyW(g_status_text, STATUS_CAPACITY, L"Patching the current FACEIT client...");
    StringCchCopyW(g_detail_text, STATUS_CAPACITY, L"Keep this window open until the operation is complete.");
  } else if (_wcsicmp(state, L"success") == 0) {
    g_busy = FALSE;
    g_completed_action = ACTION_INSTALL;
    g_ui_state = UI_STATE_SUCCESS;
    g_install_complete = TRUE;
    g_restore_available = TRUE;
    StringCchCopyW(g_status_text, STATUS_CAPACITY, L"Extension support was installed successfully.");
    StringCchCopyW(g_detail_text, STATUS_CAPACITY, L"Open FACEIT and choose Mods in the right sidebar.");
  } else if (_wcsicmp(state, L"error") == 0) {
    g_busy = FALSE;
    g_ui_state = UI_STATE_ERROR;
    StringCchCopyW(g_status_text, STATUS_CAPACITY, L"Setup could not finish.");
    StringCchCopyW(g_detail_text, STATUS_CAPACITY,
                   L"FACEIT.exe was not found for the embedded setup runtime. Open setup files for the detailed log.");
  }
  set_button_texts();
  set_controls_enabled(!g_busy);
}

static BOOL write_preview_bitmap(HWND window, const wchar_t *path) {
  RECT client;
  BITMAPINFO info;
  BITMAPFILEHEADER file_header;
  HDC memory;
  HBITMAP bitmap;
  HGDIOBJ previous_bitmap;
  BYTE *pixels = NULL;
  HANDLE file;
  DWORD written;
  DWORD pixel_bytes;
  HWND buttons[] = { g_restore, g_open_folder, g_install };
  if (!GetClientRect(window, &client)) return FALSE;
  ZeroMemory(&info, sizeof(info));
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = client.right;
  info.bmiHeader.biHeight = -client.bottom;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  memory = CreateCompatibleDC(NULL);
  bitmap = CreateDIBSection(memory, &info, DIB_RGB_COLORS, (void **)&pixels, NULL, 0);
  if (!memory || !bitmap || !pixels) return FALSE;
  previous_bitmap = SelectObject(memory, bitmap);
  render_window(window, memory);
  for (size_t index = 0; index < sizeof(buttons) / sizeof(buttons[0]); index += 1) {
    RECT rectangle;
    DRAWITEMSTRUCT item;
    int saved;
    GetWindowRect(buttons[index], &rectangle);
    MapWindowPoints(NULL, window, (POINT *)&rectangle, 2);
    ZeroMemory(&item, sizeof(item));
    item.CtlID = (UINT)GetDlgCtrlID(buttons[index]);
    item.hwndItem = buttons[index];
    item.hDC = memory;
    item.rcItem.right = rectangle.right - rectangle.left;
    item.rcItem.bottom = rectangle.bottom - rectangle.top;
    if (GetFocus() == buttons[index]) item.itemState |= ODS_FOCUS;
    if (!IsWindowEnabled(buttons[index])) item.itemState |= ODS_DISABLED;
    saved = SaveDC(memory);
    SetViewportOrgEx(memory, rectangle.left, rectangle.top, NULL);
    draw_button(&item);
    RestoreDC(memory, saved);
  }
  pixel_bytes = (DWORD)(client.right * client.bottom * 4);
  ZeroMemory(&file_header, sizeof(file_header));
  file_header.bfType = 0x4d42;
  file_header.bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
  file_header.bfSize = file_header.bfOffBits + pixel_bytes;
  file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  WriteFile(file, &file_header, sizeof(file_header), &written, NULL);
  WriteFile(file, &info.bmiHeader, sizeof(info.bmiHeader), &written, NULL);
  WriteFile(file, pixels, pixel_bytes, &written, NULL);
  CloseHandle(file);
  SelectObject(memory, previous_bitmap);
  DeleteObject(bitmap);
  DeleteDC(memory);
  return TRUE;
}
#endif

static void paint_window(HWND window) {
  PAINTSTRUCT paint;
  HDC dc = BeginPaint(window, &paint);
  render_window(window, dc);
  EndPaint(window, &paint);
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w_param, LPARAM l_param) {
  switch (message) {
    case WM_CREATE:
#ifdef FACEIT_INSTALLER_CAPTURE
      g_dpi = g_capture_dpi_override ? g_capture_dpi_override : GetDpiForWindow(window);
#else
      g_dpi = GetDpiForWindow(window);
#endif
      g_high_contrast = high_contrast_enabled();
      create_fonts();
      create_controls(window);
      return 0;
    case WM_COMMAND:
      switch (LOWORD(w_param)) {
        case IDC_INSTALL:
          if (g_ui_state == UI_STATE_SUCCESS && g_completed_action == ACTION_RESTORE) {
            DestroyWindow(window);
          } else if (g_install_complete) {
            if (!launch_faceit()) show_inline_error(g_last_error);
            else DestroyWindow(window);
          } else if (g_ui_state == UI_STATE_ERROR) {
            start_task(g_active_action);
          } else {
            start_task(ACTION_INSTALL);
          }
          return 0;
        case IDC_RESTORE:
          if (confirm_restore(window)) start_task(ACTION_RESTORE);
          return 0;
        case IDC_OPEN_FOLDER:
          open_install_folder();
          return 0;
      }
      break;
    case WM_DRAWITEM:
      if (w_param == IDC_INSTALL || w_param == IDC_RESTORE || w_param == IDC_OPEN_FOLDER) {
        draw_button((const DRAWITEMSTRUCT *)l_param);
        return TRUE;
      }
      break;
    case WM_PAINT:
      paint_window(window);
      return 0;
    case WM_PRINTCLIENT:
      render_window(window, (HDC)w_param);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_APP_STATUS: {
      wchar_t *message_text = (wchar_t *)l_param;
      StringCchCopyW(g_status_text, STATUS_CAPACITY, message_text);
      HeapFree(GetProcessHeap(), 0, message_text);
      InvalidateRect(window, NULL, FALSE);
      return 0;
    }
    case WM_APP_PROGRESS:
      g_progress_value = (int)w_param;
      InvalidateRect(window, NULL, FALSE);
      return 0;
    case WM_APP_DONE: {
      int result = (int)w_param;
      SetupAction action = (SetupAction)l_param;
      g_busy = FALSE;
      g_completed_action = action;
      if (result == 0) {
        g_ui_state = UI_STATE_SUCCESS;
        g_progress_value = 100;
        g_install_complete = action == ACTION_INSTALL;
        g_payload_installed = action == ACTION_INSTALL;
        g_restore_available = restore_backup_exists();
        StringCchCopyW(g_status_text, STATUS_CAPACITY,
                       action == ACTION_RESTORE ? L"The original FACEIT client files are active."
                                                : L"Extension support was installed successfully.");
        StringCchCopyW(g_detail_text, STATUS_CAPACITY,
                       action == ACTION_RESTORE ? L"Run setup again whenever you want to reinstall extension support."
                                                : L"Open FACEIT and choose Mods in the right sidebar.");
        set_button_texts();
        set_controls_enabled(TRUE);
      } else {
        show_inline_error(g_last_error[0] ? g_last_error : L"Open setup files for the detailed log.");
      }
      return 0;
    }
    case WM_DPICHANGED: {
      RECT *suggested = (RECT *)l_param;
      g_dpi = HIWORD(w_param);
      create_fonts();
      SetWindowPos(window, NULL, suggested->left, suggested->top,
                   suggested->right - suggested->left, suggested->bottom - suggested->top,
                   SWP_NOZORDER | SWP_NOACTIVATE);
      layout_controls(window);
      InvalidateRect(window, NULL, TRUE);
      return 0;
    }
    case WM_SETTINGCHANGE:
    case WM_THEMECHANGED:
      g_high_contrast = high_contrast_enabled();
      InvalidateRect(window, NULL, TRUE);
      return 0;
    case WM_CLOSE:
      if (g_busy) {
        StringCchCopyW(g_detail_text, STATUS_CAPACITY,
                       L"Setup is finishing the current step. The window can close when it is safe.");
        InvalidateRect(window, NULL, FALSE);
        return 0;
      }
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, w_param, l_param);
}

static int run_extract_only(const wchar_t *destination) {
  g_silent = TRUE;
  return extract_payload(destination) ? 0 : 12;
}

static int handle_command_line(void) {
  int argument_count = 0;
  wchar_t **arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  const wchar_t *extract_destination = NULL;
  SetupAction action = 0;
  int result = -1;
  if (!arguments) return -1;
  for (int index = 1; index < argument_count; index += 1) {
    if (equals_argument(arguments[index], L"/silent")) g_silent = TRUE;
    if (equals_argument(arguments[index], L"/extract-only") && index + 1 < argument_count) {
      extract_destination = arguments[index + 1];
      index += 1;
      continue;
    }
    if (equals_argument(arguments[index], L"/install")) action = ACTION_INSTALL;
    if (equals_argument(arguments[index], L"/restore")) action = ACTION_RESTORE;
  }
  if (extract_destination) result = run_extract_only(extract_destination);
  else if (action) result = perform_setup(action);
  LocalFree(arguments);
  return result;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
  INITCOMMONCONTROLSEX controls;
  WNDCLASSEXW window_class;
  MSG message;
  RECT window_rect;
  RECT work_area;
  UINT initial_dpi;
  int command_result;
  (void)previous;
  (void)command_line;

  command_result = handle_command_line();
  if (command_result >= 0) return command_result;

  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  initial_dpi = GetDpiForSystem();
#ifdef FACEIT_INSTALLER_CAPTURE
  wchar_t requested_dpi[16] = L"";
  DWORD requested_dpi_length = GetEnvironmentVariableW(L"FACEIT_MODS_CAPTURE_DPI", requested_dpi, 16);
  if (requested_dpi_length > 0 && requested_dpi_length < 16) {
    UINT parsed_dpi = (UINT)_wtoi(requested_dpi);
    if (parsed_dpi >= 96 && parsed_dpi <= 384) {
      initial_dpi = parsed_dpi;
      g_capture_dpi_override = parsed_dpi;
    }
  }
#endif
  g_dpi = initial_dpi;
  controls.dwSize = sizeof(controls);
  controls.dwICC = ICC_STANDARD_CLASSES;
  InitCommonControlsEx(&controls);
  g_background_brush = CreateSolidBrush(RGB(18, 18, 18));
  g_icon = (HICON)LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON,
                             MulDiv(48, (int)initial_dpi, 96), MulDiv(48, (int)initial_dpi, 96), 0);
  ZeroMemory(&window_class, sizeof(window_class));
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = window_proc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(NULL, IDC_ARROW);
  window_class.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
  window_class.hIconSm = (HICON)LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON,
                                           GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  window_class.hbrBackground = g_background_brush;
  window_class.lpszClassName = L"FaceitExtensionLoaderSetupWindow";
  if (!RegisterClassExW(&window_class)) return 20;
  SetRect(&window_rect, 0, 0, MulDiv(620, (int)initial_dpi, 96), MulDiv(430, (int)initial_dpi, 96));
  AdjustWindowRectExForDpi(&window_rect, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                           FALSE, 0, initial_dpi);
  int width = window_rect.right - window_rect.left;
  int height = window_rect.bottom - window_rect.top;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work_area, 0);
  int x = work_area.left + ((work_area.right - work_area.left) - width) / 2;
  int y = work_area.top + ((work_area.bottom - work_area.top) - height) / 2;
  g_window = CreateWindowExW(0, window_class.lpszClassName, APP_TITLE,
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                             x, y, width, height, NULL, NULL, instance, NULL);
  if (!g_window) return 21;
  BOOL dark = TRUE;
  DWORD corner = 2;
  DwmSetWindowAttribute(g_window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
  DwmSetWindowAttribute(g_window, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, sizeof(corner));
#ifdef FACEIT_INSTALLER_CAPTURE
  wchar_t capture_path[PATH_CAPACITY];
  DWORD capture_length = GetEnvironmentVariableW(L"FACEIT_MODS_CAPTURE_PATH", capture_path, PATH_CAPACITY);
  if (capture_length > 0 && capture_length < PATH_CAPACITY) {
    ShowWindow(g_window, SW_SHOWNOACTIVATE);
    UpdateWindow(g_window);
    configure_preview_state();
    BOOL captured = write_preview_bitmap(g_window, capture_path);
    DestroyWindow(g_window);
    delete_fonts();
    if (g_icon) DestroyIcon(g_icon);
    DeleteObject(g_background_brush);
    return captured ? 0 : 22;
  }
#endif
  ShowWindow(g_window, show_command);
  UpdateWindow(g_window);
  while (GetMessageW(&message, NULL, 0, 0) > 0) {
    if (!IsDialogMessageW(g_window, &message)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  delete_fonts();
  if (g_icon) DestroyIcon(g_icon);
  DeleteObject(g_background_brush);
  return (int)message.wParam;
}
