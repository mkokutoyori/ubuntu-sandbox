#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static long env_long(const char *name, long fallback) {
	const char *v = getenv(name);
	return v && *v ? atol(v) : fallback;
}

time_t time(time_t *t) {
	time_t now = env_long("LAST_NOW", 0);
	if (!now) { static time_t (*real)(time_t *); if (!real) real = dlsym(RTLD_NEXT, "time"); return real(t); }
	if (t) *t = now;
	return now;
}

int gettimeofday(struct timeval *tv, void *tz) {
	long now = env_long("LAST_NOW", 0);
	if (!now) { static int (*real)(struct timeval *, void *); if (!real) real = dlsym(RTLD_NEXT, "gettimeofday"); return real(tv, tz); }
	tv->tv_sec = now; tv->tv_usec = env_long("LAST_USEC", 0);
	return 0;
}

int clock_gettime(clockid_t id, struct timespec *ts) {
	long now = env_long("LAST_NOW", 0), boot = env_long("LAST_BOOT", 0);
	long offset = env_long("LAST_RT_OFFSET", 0);
	if (!now && offset && (id == CLOCK_REALTIME || id == CLOCK_REALTIME_COARSE)) {
		static int (*real_clock)(clockid_t, struct timespec *); if (!real_clock) real_clock = dlsym(RTLD_NEXT, "clock_gettime");
		int rc = real_clock(id, ts); ts->tv_sec += offset; return rc;
	}
	if (now && id == CLOCK_REALTIME) { ts->tv_sec = now; ts->tv_nsec = 0; return 0; }
	if (now && id == CLOCK_BOOTTIME) { ts->tv_sec = now - boot; ts->tv_nsec = 0; return 0; }
	static int (*real)(clockid_t, struct timespec *); if (!real) real = dlsym(RTLD_NEXT, "clock_gettime");
	return real(id, ts);
}

static int lookup(const char *list, const char *key, long *value) {
	if (!list) return 0;
	char *copy = strdup(list), *save = NULL;
	int found = 0;
	for (char *item = strtok_r(copy, ",", &save); item; item = strtok_r(NULL, ",", &save)) {
		char *colon = strrchr(item, ':');
		if (!colon) continue;
		*colon = 0;
		if (strcmp(item, key) == 0) { *value = atol(colon + 1); found = 1; if (!strcmp(colon + 1, "bad")) *value = -1; break; }
	}
	free(copy);
	return found;
}

struct passwd *getpwnam(const char *name) {
	static struct passwd pw;
	long uid;
	if (!lookup(getenv("LAST_USERS"), name, &uid)) return NULL;
	memset(&pw, 0, sizeof pw);
	pw.pw_name = (char *)name; pw.pw_uid = (uid_t)uid; pw.pw_gid = (gid_t)uid; pw.pw_dir = "/"; pw.pw_shell = "/bin/sh";
	return &pw;
}

static int loginuid_pid(const char *path, char *pid) {
	return sscanf(path, "/proc/%31[0-9]/loginuid", pid) == 1;
}

int access(const char *path, int mode) {
	char pid[32]; long v;
	if (loginuid_pid(path, pid)) return lookup(getenv("LAST_LOGINUIDS"), pid, &v) ? 0 : (errno = ENOENT, -1);
	static int (*real)(const char *, int); if (!real) real = dlsym(RTLD_NEXT, "access");
	return real(path, mode);
}

FILE *fopen(const char *path, const char *mode) {
	char pid[32]; long v;
	if (strcmp(path, "/var/log/lastlog") == 0 && getenv("LAST_LASTLOG")) path = getenv("LAST_LASTLOG");
	if (strcmp(path, "/etc/login.defs") == 0 && getenv("LAST_LOGINDEFS")) path = getenv("LAST_LOGINDEFS");
	if (loginuid_pid(path, pid)) {
		if (!lookup(getenv("LAST_LOGINUIDS"), pid, &v)) { errno = ENOENT; return NULL; }
		char *text = v < 0 ? strdup("x\n") : NULL;
		if (!text) { text = malloc(32); snprintf(text, 32, "%ld\n", v); }
		return fmemopen(text, strlen(text), "r");
	}
	static FILE *(*real)(const char *, const char *); if (!real) real = dlsym(RTLD_NEXT, "fopen");
	return real(path, mode);
}

int stat(const char *path, struct stat *st) {
	long v;
	if (strncmp(path, "/dev/", 5) == 0 && getenv("LAST_TTYOWNERS")) {
		if (!lookup(getenv("LAST_TTYOWNERS"), path + 5, &v)) { errno = ENOENT; return -1; }
		memset(st, 0, sizeof *st); st->st_uid = (uid_t)v;
		return 0;
	}
	static int (*real)(const char *, struct stat *); if (!real) real = dlsym(RTLD_NEXT, "stat");
	return real(path, st);
}

static struct passwd *entry_at(int index) {
	static struct passwd pw;
	static char name[64];
	const char *list = getenv("LAST_USERS");
	if (!list) return NULL;
	char *copy = strdup(list), *save = NULL;
	int at = 0;
	struct passwd *result = NULL;
	for (char *item = strtok_r(copy, ",", &save); item; item = strtok_r(NULL, ",", &save), at++) {
		if (at != index) continue;
		char *colon = strrchr(item, ':');
		if (!colon) break;
		*colon = 0;
		snprintf(name, sizeof name, "%s", item);
		memset(&pw, 0, sizeof pw);
		pw.pw_name = name; pw.pw_uid = (uid_t)atol(colon + 1); pw.pw_gid = pw.pw_uid; pw.pw_dir = "/"; pw.pw_shell = "/bin/sh";
		result = &pw;
		break;
	}
	free(copy);
	return result;
}

static int walk;
void setpwent(void) { walk = 0; }
void endpwent(void) { walk = 0; }
struct passwd *getpwent(void) { return entry_at(walk++); }
struct passwd *getpwuid(uid_t uid) {
	for (int i = 0;; i++) {
		struct passwd *p = entry_at(i);
		if (!p) return NULL;
		if (p->pw_uid == uid) return p;
	}
}

#include <sys/types.h>
int gethostname(char *name, size_t len) {
	const char *fake = getenv("LAST_HOSTNAME");
	if (!fake) { static int (*real)(char *, size_t); if (!real) real = dlsym(RTLD_NEXT, "gethostname"); return real(name, len); }
	if (strlen(fake) >= len) { errno = ENAMETOOLONG; return -1; }
	strcpy(name, fake);
	return 0;
}
pid_t getpid(void) {
	long fake = env_long("LAST_PID", 0);
	if (!fake) { static pid_t (*real)(void); if (!real) real = dlsym(RTLD_NEXT, "getpid"); return real(); }
	return (pid_t)fake;
}
uid_t getuid(void) {
	const char *fake = getenv("LAST_UID");
	if (!fake) { static uid_t (*real)(void); if (!real) real = dlsym(RTLD_NEXT, "getuid"); return real(); }
	return (uid_t)atol(fake);
}

#include <fcntl.h>
#include <stdarg.h>
#include <sys/mman.h>
#include <sys/syscall.h>

static int fake_file(const char *content) {
	int fd = memfd_create("fake", 0);
	if (fd < 0) return -1;
	ssize_t ignored = write(fd, content, strlen(content));
	if (!strchr(content, 10)) ignored = write(fd, "\n", 1);
	(void)ignored;
	lseek(fd, 0, SEEK_SET);
	return fd;
}

int open(const char *path, int flags, ...) {
	mode_t mode = 0;
	if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
	if (strcmp(path, "/proc/sys/kernel/random/boot_id") == 0 && getenv("LAST_BOOT_ID")) return fake_file(getenv("LAST_BOOT_ID"));
	if (strcmp(path, "/etc/machine-id") == 0 && getenv("LAST_MACHINE_ID")) return fake_file(getenv("LAST_MACHINE_ID"));
	static int (*real)(const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "open");
	return real(path, flags, mode);
}
int open64(const char *path, int flags, ...) {
	mode_t mode = 0;
	if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
	if (strcmp(path, "/proc/sys/kernel/random/boot_id") == 0 && getenv("LAST_BOOT_ID")) return fake_file(getenv("LAST_BOOT_ID"));
	if (strcmp(path, "/etc/machine-id") == 0 && getenv("LAST_MACHINE_ID")) return fake_file(getenv("LAST_MACHINE_ID"));
	static int (*real)(const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "open64");
	return real(path, flags, mode);
}
int openat(int dirfd, const char *path, int flags, ...) {
	mode_t mode = 0;
	if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
	if (strcmp(path, "/proc/sys/kernel/random/boot_id") == 0 && getenv("LAST_BOOT_ID")) return fake_file(getenv("LAST_BOOT_ID"));
	if (strcmp(path, "/etc/machine-id") == 0 && getenv("LAST_MACHINE_ID")) return fake_file(getenv("LAST_MACHINE_ID"));
	static int (*real)(int, const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "openat");
	return real(dirfd, path, flags, mode);
}

static const char *fake_path_content(const char *path) {
	if (strcmp(path, "/proc/sys/kernel/random/boot_id") == 0 && getenv("LAST_BOOT_ID")) return getenv("LAST_BOOT_ID");
	if (strcmp(path, "/etc/machine-id") == 0 && getenv("LAST_MACHINE_ID")) return getenv("LAST_MACHINE_ID");
	return NULL;
}
int __open_2(const char *path, int flags) {
	const char *c = fake_path_content(path); if (c) return fake_file(c);
	static int (*real)(const char *, int); if (!real) real = dlsym(RTLD_NEXT, "__open_2");
	return real(path, flags);
}
int __open64_2(const char *path, int flags) {
	const char *c = fake_path_content(path); if (c) return fake_file(c);
	static int (*real)(const char *, int); if (!real) real = dlsym(RTLD_NEXT, "__open64_2");
	return real(path, flags);
}
int __openat_2(int dirfd, const char *path, int flags) {
	const char *c = fake_path_content(path); if (c) return fake_file(c);
	static int (*real)(int, const char *, int); if (!real) real = dlsym(RTLD_NEXT, "__openat_2");
	return real(dirfd, path, flags);
}
int __openat64_2(int dirfd, const char *path, int flags) {
	const char *c = fake_path_content(path); if (c) return fake_file(c);
	static int (*real)(int, const char *, int); if (!real) real = dlsym(RTLD_NEXT, "__openat64_2");
	return real(dirfd, path, flags);
}

int openat64(int dirfd, const char *path, int flags, ...) {
	mode_t mode = 0;
	if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
	const char *c = fake_path_content(path); if (c) return fake_file(c);
	static int (*real)(int, const char *, int, ...); if (!real) real = dlsym(RTLD_NEXT, "openat64");
	return real(dirfd, path, flags, mode);
}
FILE *fopen64(const char *path, const char *mode) {
	const char *c = fake_path_content(path);
	if (c) { char *text = strdup(c); return fmemopen(text, strlen(text), "r"); }
	static FILE *(*real)(const char *, const char *); if (!real) real = dlsym(RTLD_NEXT, "fopen64");
	return real(path, mode);
}
