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

#define IDC_INSTALL 100
#define IDC_RESTORE 101
#define IDC_OPEN_FOLDER 103
#define IDC_STATUS 105
#define IDC_PROGRESS 106

typedef enum SetupAction {
  ACTION_INSTALL = 1,
  ACTION_RESTORE = 2
} SetupAction;

typedef struct TaskArgs {
  SetupAction action;
} TaskArgs;

static HWND g_window;
static HWND g_status;
static HWND g_detail;
static HWND g_progress;
static HWND g_install;
static HWND g_restore;
static HWND g_open_folder;
static HFONT g_title_font;
static HFONT g_body_font;
static HFONT g_small_font;
static HBRUSH g_background_brush;
static BOOL g_busy;
static BOOL g_silent;
static BOOL g_install_complete;
static wchar_t g_last_error[STATUS_CAPACITY];

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

static void set_controls_enabled(BOOL enabled) {
  EnableWindow(g_install, enabled);
  EnableWindow(g_restore, enabled);
  EnableWindow(g_open_folder, enabled);
  InvalidateRect(g_window, NULL, FALSE);
}

static DWORD WINAPI setup_thread(LPVOID parameter) {
  TaskArgs *task = (TaskArgs *)parameter;
  SetupAction action = task->action;
  HeapFree(GetProcessHeap(), 0, task);
  int result = perform_setup(action);
  PostMessageW(g_window, WM_APP_DONE, (WPARAM)result, (LPARAM)action);
  return 0;
}

static void start_task(SetupAction action) {
  TaskArgs *task;
  HANDLE thread;
  if (g_busy) return;
  g_busy = TRUE;
  set_controls_enabled(FALSE);
  SendMessageW(g_progress, PBM_SETPOS, 0, 0);
  task = (TaskArgs *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(TaskArgs));
  if (!task) {
    g_busy = FALSE;
    set_controls_enabled(TRUE);
    return;
  }
  task->action = action;
  thread = CreateThread(NULL, 0, setup_thread, task, 0, NULL);
  if (!thread) {
    HeapFree(GetProcessHeap(), 0, task);
    g_busy = FALSE;
    set_controls_enabled(TRUE);
    MessageBoxW(g_window, L"Could not start the setup task.", APP_TITLE, MB_ICONERROR);
    return;
  }
  CloseHandle(thread);
}

static void draw_button(const DRAWITEMSTRUCT *item) {
  BOOL disabled = !IsWindowEnabled(item->hwndItem);
  BOOL primary = item->CtlID == IDC_INSTALL;
  COLORREF background = disabled ? RGB(39, 39, 39) : (primary ? RGB(255, 85, 0) : RGB(46, 46, 46));
  COLORREF border = disabled ? RGB(52, 52, 52) : (primary ? RGB(255, 103, 31) : RGB(70, 70, 70));
  HBRUSH brush = CreateSolidBrush(background);
  HPEN pen = CreatePen(PS_SOLID, 1, border);
  HGDIOBJ old_brush = SelectObject(item->hDC, brush);
  HGDIOBJ old_pen = SelectObject(item->hDC, pen);
  wchar_t text[128];
  RECT text_rect = item->rcItem;
  RoundRect(item->hDC, item->rcItem.left, item->rcItem.top, item->rcItem.right, item->rcItem.bottom, 6, 6);
  SelectObject(item->hDC, old_brush);
  SelectObject(item->hDC, old_pen);
  DeleteObject(brush);
  DeleteObject(pen);
  GetWindowTextW(item->hwndItem, text, 128);
  SetBkMode(item->hDC, TRANSPARENT);
  SetTextColor(item->hDC, disabled ? RGB(120, 120, 120) : RGB(245, 245, 245));
  SelectObject(item->hDC, g_body_font);
  DrawTextW(item->hDC, text, -1, &text_rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  if (item->itemState & ODS_FOCUS) {
    RECT focus = item->rcItem;
    InflateRect(&focus, -3, -3);
    DrawFocusRect(item->hDC, &focus);
  }
}

static HWND create_label(HWND parent, const wchar_t *text, int x, int y, int width, int height, HFONT font) {
  HWND label = CreateWindowExW(0, L"STATIC", text, WS_CHILD | WS_VISIBLE | SS_LEFT,
                               x, y, width, height, parent, NULL, GetModuleHandleW(NULL), NULL);
  SendMessageW(label, WM_SETFONT, (WPARAM)font, TRUE);
  return label;
}

static HWND create_button(HWND parent, int id, const wchar_t *text, int x, int y, int width, int height) {
  HWND button = CreateWindowExW(0, L"BUTTON", text, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
                                x, y, width, height, parent, (HMENU)(INT_PTR)id, GetModuleHandleW(NULL), NULL);
  SendMessageW(button, WM_SETFONT, (WPARAM)g_body_font, TRUE);
  return button;
}

static void create_controls(HWND window) {
  create_label(window, L"FACEIT Mods", 28, 20, 300, 34, g_title_font);
  create_label(window, L"Windows setup  " APP_VERSION, 30, 55, 300, 22, g_small_font);
  create_label(window, L"Self-contained | current user | no administrator rights",
               30, 80, 460, 20, g_small_font);
  g_status = create_label(window, L"Ready to install. FACEIT.exe closes automatically when setup starts.",
                          30, 117, 460, 42, g_body_font);
  g_progress = CreateWindowExW(0, PROGRESS_CLASSW, NULL, WS_CHILD | WS_VISIBLE | PBS_SMOOTH,
                               30, 167, 460, 7, window, (HMENU)(INT_PTR)IDC_PROGRESS, GetModuleHandleW(NULL), NULL);
  SendMessageW(g_progress, PBM_SETRANGE, 0, MAKELPARAM(0, 100));
  SendMessageW(g_progress, PBM_SETBARCOLOR, 0, RGB(255, 85, 0));
  SendMessageW(g_progress, PBM_SETBKCOLOR, 0, RGB(48, 48, 48));
  g_install = create_button(window, IDC_INSTALL, L"Install or update", 30, 194, 460, 44);
  g_restore = create_button(window, IDC_RESTORE, L"Restore FACEIT", 30, 251, 224, 38);
  g_open_folder = create_button(window, IDC_OPEN_FOLDER, L"Open setup folder", 266, 251, 224, 38);
  g_detail = create_label(window, L"Uses the runtime already included with FACEIT | no download required",
                          30, 305, 460, 20, g_small_font);
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w_param, LPARAM l_param) {
  switch (message) {
    case WM_CREATE:
      create_controls(window);
      return 0;
    case WM_COMMAND:
      switch (LOWORD(w_param)) {
        case IDC_INSTALL:
          if (g_install_complete) {
            if (!launch_faceit()) MessageBoxW(window, g_last_error, APP_TITLE, MB_ICONERROR);
            else SetWindowTextW(g_status, L"FACEIT started.");
          } else {
            start_task(ACTION_INSTALL);
          }
          return 0;
        case IDC_RESTORE: start_task(ACTION_RESTORE); return 0;
        case IDC_OPEN_FOLDER: open_install_folder(); return 0;
      }
      break;
    case WM_DRAWITEM:
      if (w_param == IDC_INSTALL || w_param == IDC_RESTORE || w_param == IDC_OPEN_FOLDER) {
        draw_button((const DRAWITEMSTRUCT *)l_param);
        return TRUE;
      }
      break;
    case WM_CTLCOLORSTATIC: {
      HDC dc = (HDC)w_param;
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, (HWND)l_param == g_status ? RGB(225, 225, 225) : RGB(165, 165, 165));
      return (LRESULT)g_background_brush;
    }
    case WM_PAINT: {
      PAINTSTRUCT paint;
      HDC dc = BeginPaint(window, &paint);
      RECT client;
      GetClientRect(window, &client);
      FillRect(dc, &client, g_background_brush);
      RECT accent = {0, 0, 5, client.bottom};
      HBRUSH accent_brush = CreateSolidBrush(RGB(255, 85, 0));
      FillRect(dc, &accent, accent_brush);
      DeleteObject(accent_brush);
      RECT separator = {30, 104, client.right - 30, 105};
      HBRUSH separator_brush = CreateSolidBrush(RGB(48, 48, 48));
      FillRect(dc, &separator, separator_brush);
      DeleteObject(separator_brush);
      EndPaint(window, &paint);
      return 0;
    }
    case WM_APP_STATUS: {
      wchar_t *message_text = (wchar_t *)l_param;
      SetWindowTextW(g_status, message_text);
      HeapFree(GetProcessHeap(), 0, message_text);
      return 0;
    }
    case WM_APP_PROGRESS:
      SendMessageW(g_progress, PBM_SETPOS, w_param, 0);
      return 0;
    case WM_APP_DONE: {
      int result = (int)w_param;
      SetupAction action = (SetupAction)l_param;
      g_busy = FALSE;
      set_controls_enabled(TRUE);
      if (result == 0) {
        const wchar_t *message_text = action == ACTION_RESTORE
          ? L"The original FACEIT client was restored."
          : L"FACEIT Mods was installed. You can launch FACEIT now.";
        SetWindowTextW(g_status, message_text);
        g_install_complete = action == ACTION_INSTALL;
        SetWindowTextW(g_install, g_install_complete ? L"Launch FACEIT" : L"Install or update");
        SetWindowTextW(g_detail, action == ACTION_RESTORE
          ? L"The original app.asar backup is active"
          : L"Installed successfully | use Mods in the FACEIT right sidebar");
      } else {
        SetWindowTextW(g_status, L"Setup failed. See the error and setup.log.");
        MessageBoxW(window, g_last_error[0] ? g_last_error : L"Setup failed.", APP_TITLE, MB_OK | MB_ICONERROR);
      }
      return 0;
    }
    case WM_CLOSE:
      if (g_busy) {
        MessageBoxW(window, L"Wait for the current operation to finish.", APP_TITLE, MB_OK | MB_ICONINFORMATION);
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
  RECT window_rect = {0, 0, 520, 340};
  int command_result;
  (void)previous;
  (void)command_line;

  command_result = handle_command_line();
  if (command_result >= 0) return command_result;

  controls.dwSize = sizeof(controls);
  controls.dwICC = ICC_PROGRESS_CLASS;
  InitCommonControlsEx(&controls);
  SetProcessDPIAware();
  g_background_brush = CreateSolidBrush(RGB(24, 24, 24));
  g_title_font = CreateFontW(-28, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
  g_body_font = CreateFontW(-16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                            DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
  g_small_font = CreateFontW(-14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                             OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                             DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
  ZeroMemory(&window_class, sizeof(window_class));
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = window_proc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(NULL, IDC_ARROW);
  window_class.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
  window_class.hIconSm = (HICON)LoadImageW(instance, MAKEINTRESOURCEW(1), IMAGE_ICON,
                                           GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  window_class.hbrBackground = g_background_brush;
  window_class.lpszClassName = L"FaceitModsSetupWindow";
  if (!RegisterClassExW(&window_class)) return 20;
  AdjustWindowRectEx(&window_rect, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, FALSE, 0);
  int width = window_rect.right - window_rect.left;
  int height = window_rect.bottom - window_rect.top;
  int x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
  int y = (GetSystemMetrics(SM_CYSCREEN) - height) / 2;
  g_window = CreateWindowExW(0, window_class.lpszClassName, APP_TITLE,
                             WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                             x, y, width, height, NULL, NULL, instance, NULL);
  if (!g_window) return 21;
  BOOL dark = TRUE;
  DwmSetWindowAttribute(g_window, 20, &dark, sizeof(dark));
  ShowWindow(g_window, show_command);
  UpdateWindow(g_window);
  while (GetMessageW(&message, NULL, 0, 0) > 0) {
    if (!IsDialogMessageW(g_window, &message)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  DeleteObject(g_title_font);
  DeleteObject(g_body_font);
  DeleteObject(g_small_font);
  DeleteObject(g_background_brush);
  return (int)message.wParam;
}
