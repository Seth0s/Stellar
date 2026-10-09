#include <node_api.h>

#include <stdint.h>

#if defined(__linux__)
#include <sys/socket.h>
#include <sys/types.h>
#elif defined(__APPLE__)
#include <libproc.h>
#include <sys/socket.h>
#include <sys/types.h>
#endif

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

static napi_value get_peer_credentials(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return fail(env, "socket descriptor is required");
  }

  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    return fail(env, "socket descriptor is unavailable");
  }

  int64_t pid = -1;
#if defined(__linux__)
  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0 || length != sizeof(credentials)) {
    return fail(env, "SO_PEERCRED failed");
  }
  pid = credentials.pid;
#elif defined(__APPLE__)
  pid_t peer_pid = -1;
  socklen_t length = sizeof(peer_pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &length) != 0 || length != sizeof(peer_pid)) {
    return fail(env, "LOCAL_PEERPID failed");
  }
  pid = peer_pid;
#else
  return fail(env, "peer credentials are unavailable on this transport");
#endif

  napi_value result;
  napi_value peer_pid_value;
  if (napi_create_object(env, &result) != napi_ok || napi_create_int64(env, pid, &peer_pid_value) != napi_ok ||
      napi_set_named_property(env, result, "pid", peer_pid_value) != napi_ok) {
    return fail(env, "could not create peer credentials result");
  }
  return result;
}

static napi_value get_process_info(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return fail(env, "process id is required");
  }

  int32_t pid = 0;
  if (napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    return fail(env, "process id is invalid");
  }

#if defined(__APPLE__)
  struct proc_bsdinfo process_info;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process_info, sizeof(process_info));
  if (size != sizeof(process_info) || process_info.pbi_pid != static_cast<uint32_t>(pid)) {
    return fail(env, "proc_pidinfo failed");
  }
  const uint64_t start_time = static_cast<uint64_t>(process_info.pbi_start_tvsec) * 1000000ULL +
                              static_cast<uint64_t>(process_info.pbi_start_tvusec);
  napi_value result;
  napi_value pid_value;
  napi_value parent_value;
  napi_value start_value;
  if (napi_create_object(env, &result) != napi_ok || napi_create_int32(env, pid, &pid_value) != napi_ok ||
      napi_create_uint32(env, process_info.pbi_ppid, &parent_value) != napi_ok ||
      napi_create_bigint_uint64(env, start_time, &start_value) != napi_ok ||
      napi_set_named_property(env, result, "pid", pid_value) != napi_ok ||
      napi_set_named_property(env, result, "parentPid", parent_value) != napi_ok ||
      napi_set_named_property(env, result, "startTime", start_value) != napi_ok) {
    return fail(env, "could not create process info result");
  }
  return result;
#else
  return fail(env, "process info is read from /proc on this platform");
#endif
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "getPeerCredentials", NAPI_AUTO_LENGTH, get_peer_credentials, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "getPeerCredentials", function) != napi_ok) {
    return fail(env, "could not export peer credentials function");
  }
  if (napi_create_function(env, "getProcessInfo", NAPI_AUTO_LENGTH, get_process_info, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "getProcessInfo", function) != napi_ok) {
    return fail(env, "could not export process info function");
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
