#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <linux/audit.h>
#include <linux/netlink.h>
#include <poll.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#define NR_LISTS 8
#ifndef AUDIT_FILTER_MASK
#define AUDIT_FILTER_MASK 0x07
#endif
#ifndef AUDIT_FILTER_PREPEND
#define AUDIT_FILTER_PREPEND 0x10
#endif
#ifndef AUDIT_LOCKED
#define AUDIT_LOCKED 2
#endif
#define MAX_RULES 64
#define MAX_RULE_SIZE (sizeof(struct audit_rule_data) + 4096)
#define HZ_WAIT_DEFAULT 15000

struct rule_blob {
	uint32_t size;
	unsigned char data[MAX_RULE_SIZE];
};

struct kernel_state {
	struct audit_status st;
	struct audit_features ft;
	uint32_t nrules[NR_LISTS];
	struct rule_blob rules[NR_LISTS][MAX_RULES];
};

struct pending {
	struct pending *next;
	size_t len;
	unsigned char data[];
};

static int fake_fd = -1;
static struct kernel_state *ks;
static struct pending *head, *tail;
static uint32_t last_seq;

static const char *state_path(void)
{
	return getenv("FAKE_AUDIT_STATE");
}

static void init_state(void)
{
	memset(ks, 0, sizeof(*ks));
	ks->st.enabled = 0;
	ks->st.failure = 1;
	ks->st.backlog_limit = 64;
	ks->st.feature_bitmap = AUDIT_FEATURE_BITMAP_ALL;
	ks->st.backlog_wait_time = HZ_WAIT_DEFAULT;
	ks->ft.vers = AUDIT_FEATURE_VERSION;
	ks->ft.mask = AUDIT_FEATURE_ONLY_UNSET_LOGINUID | AUDIT_FEATURE_LOGINUID_IMMUTABLE;
	ks->ft.mask = 0x3;
}

static void load_state(void)
{
	FILE *f;
	if (ks)
		return;
	ks = calloc(1, sizeof(*ks));
	init_state();
	if (state_path() && (f = fopen(state_path(), "rb"))) {
		if (fread(ks, sizeof(*ks), 1, f) != 1)
			init_state();
		fclose(f);
	}
}

static void save_state(void)
{
	FILE *f;
	if (!state_path())
		return;
	f = fopen(state_path(), "wb");
	if (f) {
		fwrite(ks, sizeof(*ks), 1, f);
		fclose(f);
	}
}

static void enqueue(uint16_t type, uint32_t seq, const void *payload, size_t plen)
{
	size_t total = NLMSG_SPACE(plen);
	struct pending *p = calloc(1, sizeof(*p) + total);
	struct nlmsghdr *h = (struct nlmsghdr *)p->data;
	h->nlmsg_len = NLMSG_LENGTH(plen);
	h->nlmsg_type = type;
	h->nlmsg_seq = seq;
	h->nlmsg_flags = 0;
	if (plen)
		memcpy(NLMSG_DATA(h), payload, plen);
	p->len = h->nlmsg_len;
	if (tail)
		tail->next = p;
	else
		head = p;
	tail = p;
}

static void enqueue_ack(uint32_t seq, int err)
{
	struct { int error; struct nlmsghdr msg; } e;
	memset(&e, 0, sizeof(e));
	e.error = err;
	e.msg.nlmsg_seq = seq;
	enqueue(NLMSG_ERROR, seq, &e, sizeof(e));
}

static int rule_equal(const struct rule_blob *a, const struct audit_rule_data *r, uint32_t size)
{
	return a->size == size && memcmp(a->data, r, size) == 0;
}

static int find_rule(int list, const struct audit_rule_data *r, uint32_t size)
{
	uint32_t i;
	for (i = 0; i < ks->nrules[list]; i++)
		if (rule_equal(&ks->rules[list][i], r, size))
			return (int)i;
	return -1;
}

static int validate_rule(const struct audit_rule_data *r, uint32_t size)
{
	unsigned int i, list = r->flags & ~AUDIT_FILTER_PREPEND;
	size_t off = 0;
	if (size < sizeof(*r))
		return -EINVAL;
	if (list >= NR_LISTS || list == AUDIT_FILTER_ENTRY)
		return -EINVAL;
	if (r->action != AUDIT_NEVER && r->action != AUDIT_POSSIBLE && r->action != AUDIT_ALWAYS)
		return -EINVAL;
	if (r->field_count > AUDIT_MAX_FIELDS)
		return -EINVAL;
	for (i = 0; i < r->field_count; i++) {
		uint32_t f = r->fields[i];
		if (f == AUDIT_WATCH || f == AUDIT_DIR) {
			char path[4097];
			char *dir;
			uint32_t len = r->values[i];
			struct stat sb;
			if (list != AUDIT_FILTER_EXIT || (r->fieldflags[i] & AUDIT_OPERATORS) != AUDIT_EQUAL)
				return -EINVAL;
			if (off + len > r->buflen || len == 0 || len > 4096)
				return -EINVAL;
			memcpy(path, &r->buf[off], len);
			path[len] = 0;
			if (path[0] != '/')
				return -EINVAL;
			dir = dirname(path);
			if (stat(dir, &sb) != 0)
				return -ENOENT;
		}
		if (f == AUDIT_WATCH || f == AUDIT_DIR || f == AUDIT_FILTERKEY || f == AUDIT_EXE ||
		    (f >= AUDIT_SUBJ_USER && f <= AUDIT_OBJ_LEV_HIGH && f != AUDIT_PPID))
			off += r->values[i];
		if (f == AUDIT_PERM && (list != AUDIT_FILTER_EXIT && list != AUDIT_FILTER_EXCLUDE))
			return -EINVAL;
	}
	return 0;
}

static int cfg_change(void)
{
	return ks->st.enabled == AUDIT_LOCKED ? -EPERM : 0;
}

static int handle_set(const struct audit_status *s)
{
	int err;
	if (s->mask & AUDIT_STATUS_ENABLED) {
		if (s->enabled > AUDIT_LOCKED)
			return -EINVAL;
		if ((err = cfg_change()) < 0)
			return err;
		ks->st.enabled = s->enabled;
	}
	if (s->mask & AUDIT_STATUS_FAILURE) {
		if (s->failure != 0 && s->failure != 1 && s->failure != 2)
			return -EINVAL;
		if ((err = cfg_change()) < 0)
			return err;
		ks->st.failure = s->failure;
	}
	if (s->mask & AUDIT_STATUS_PID)
		ks->st.pid = s->pid;
	if (s->mask & AUDIT_STATUS_RATE_LIMIT) {
		if ((err = cfg_change()) < 0)
			return err;
		ks->st.rate_limit = s->rate_limit;
	}
	if (s->mask & AUDIT_STATUS_BACKLOG_LIMIT) {
		if ((err = cfg_change()) < 0)
			return err;
		ks->st.backlog_limit = s->backlog_limit;
	}
	if (s->mask & AUDIT_STATUS_BACKLOG_WAIT_TIME) {
		if (s->backlog_wait_time > 10 * HZ_WAIT_DEFAULT)
			return -EINVAL;
		if ((err = cfg_change()) < 0)
			return err;
		ks->st.backlog_wait_time = s->backlog_wait_time;
	}
	if (s->mask & AUDIT_STATUS_LOST)
		ks->st.lost = 0;
	if (s->mask & AUDIT_STATUS_BACKLOG_WAIT_TIME_ACTUAL)
		ks->st.backlog_wait_time_actual = 0;
	return 0;
}

static void handle_request(const struct nlmsghdr *h)
{
	if (getenv("FAKE_AUDIT_DEBUG"))
		fprintf(stderr, "[fake kernel] type=%d len=%u\n", h->nlmsg_type, h->nlmsg_len);
	const unsigned char *payload = NLMSG_DATA(h);
	uint32_t plen = h->nlmsg_len - NLMSG_HDRLEN;
	int err = 0;
	uint32_t seq = h->nlmsg_seq;
	last_seq = seq;
	switch (h->nlmsg_type) {
	case AUDIT_GET: {
		struct audit_status s = ks->st;
		s.mask = AUDIT_STATUS_ENABLED | AUDIT_STATUS_FAILURE | AUDIT_STATUS_PID | AUDIT_STATUS_RATE_LIMIT |
			 AUDIT_STATUS_BACKLOG_LIMIT | AUDIT_STATUS_BACKLOG_WAIT_TIME;
		enqueue_ack(seq, 0);
		enqueue(AUDIT_GET, seq, &s, sizeof(s));
		return;
	}
	case AUDIT_SET:
		if (plen < sizeof(struct audit_status))
			err = -EINVAL;
		else
			err = handle_set((const struct audit_status *)payload);
		break;
	case AUDIT_GET_FEATURE:
		enqueue_ack(seq, 0);
		enqueue(AUDIT_GET_FEATURE, seq, &ks->ft, sizeof(ks->ft));
		return;
	case AUDIT_SET_FEATURE: {
		const struct audit_features *f = (const struct audit_features *)payload;
		if (plen < sizeof(*f))
			err = -EINVAL;
		else if (f->mask & ~(uint32_t)0x3)
			err = -EINVAL;
		else if ((f->mask & ks->ft.lock) != 0)
			err = -EPERM;
		else {
			ks->ft.features = (ks->ft.features & ~f->mask) | (f->features & f->mask);
			ks->ft.lock |= f->lock & f->mask;
		}
		break;
	}
	case AUDIT_LIST_RULES: {
		int l;
		uint32_t i;
		enqueue_ack(seq, 0);
		for (l = 0; l < NR_LISTS; l++)
			for (i = 0; i < ks->nrules[l]; i++)
				enqueue(AUDIT_LIST_RULES, seq, ks->rules[l][i].data, ks->rules[l][i].size);
		enqueue(NLMSG_DONE, seq, "\0\0\0\0", 4);
		return;
	}
	case AUDIT_ADD_RULE:
	case AUDIT_DEL_RULE: {
		const struct audit_rule_data *r = (const struct audit_rule_data *)payload;
		int list;
		int idx;
		if (plen < sizeof(*r)) {
			err = -EINVAL;
			break;
		}
		if (ks->st.enabled == AUDIT_LOCKED) {
			err = -EPERM;
			break;
		}
		list = r->flags & AUDIT_FILTER_MASK;
		if (plen < sizeof(*r) + r->buflen) {
			err = -EINVAL;
			break;
		}
		plen = sizeof(*r) + r->buflen;
		if ((err = validate_rule(r, plen)) < 0)
			break;
		{
			struct audit_rule_data *norm = malloc(plen);
			memcpy(norm, r, plen);
			norm->flags &= ~AUDIT_FILTER_PREPEND;
			idx = find_rule(list, norm, plen);
			if (h->nlmsg_type == AUDIT_ADD_RULE) {
				if (idx >= 0)
					err = -EEXIST;
				else if (ks->nrules[list] >= MAX_RULES)
					err = -ENOSPC;
				else {
					uint32_t n = ks->nrules[list];
					if (r->flags & AUDIT_FILTER_PREPEND) {
						memmove(&ks->rules[list][1], &ks->rules[list][0], n * sizeof(struct rule_blob));
						idx = 0;
					} else
						idx = (int)n;
					ks->rules[list][idx].size = plen;
					memcpy(ks->rules[list][idx].data, norm, plen);
					ks->nrules[list] = n + 1;
				}
			} else {
				if (idx < 0)
					err = -ENOENT;
				else {
					memmove(&ks->rules[list][idx], &ks->rules[list][idx + 1], (ks->nrules[list] - idx - 1) * sizeof(struct rule_blob));
					ks->nrules[list]--;
				}
			}
			free(norm);
		}
		break;
	}
	case AUDIT_SIGNAL_INFO: {
		struct { uid_t uid; pid_t pid; char ctx[1]; } info = { 0, (pid_t)ks->st.pid, { 0 } };
		enqueue_ack(seq, 0);
		enqueue(AUDIT_SIGNAL_INFO, seq, &info, sizeof(info));
		return;
	}
	case AUDIT_USER:
	case AUDIT_TRIM:
	case AUDIT_MAKE_EQUIV:
		break;
	default:
		err = -EINVAL;
		break;
	}
	if (getenv("FAKE_AUDIT_DEBUG"))
		fprintf(stderr, "[fake kernel]   -> err=%d\n", err);
	enqueue_ack(seq, err);
}

int socket(int domain, int type, int protocol)
{
	int (*real)(int, int, int) = dlsym(RTLD_NEXT, "socket");
	if (domain == AF_NETLINK && protocol == NETLINK_AUDIT) {
		load_state();
		if (fake_fd < 0)
			fake_fd = open("/dev/null", O_RDWR);
		return fake_fd;
	}
	return real(domain, type, protocol);
}

ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *addr, socklen_t alen)
{
	ssize_t (*real)(int, const void *, size_t, int, const struct sockaddr *, socklen_t) = dlsym(RTLD_NEXT, "sendto");
	if (fd == fake_fd && fd >= 0) {
		handle_request((const struct nlmsghdr *)buf);
		save_state();
		return (ssize_t)len;
	}
	return real(fd, buf, len, flags, addr, alen);
}

ssize_t recvfrom(int fd, void *buf, size_t len, int flags, struct sockaddr *addr, socklen_t *alen)
{
	ssize_t (*real)(int, void *, size_t, int, struct sockaddr *, socklen_t *) = dlsym(RTLD_NEXT, "recvfrom");
	if (fd == fake_fd && fd >= 0) {
		struct pending *p = head;
		size_t n;
		if (!p) {
			errno = EAGAIN;
			return -1;
		}
		n = p->len < len ? p->len : len;
		memcpy(buf, p->data, n);
		if (addr && alen) {
			struct sockaddr_nl nl;
			memset(&nl, 0, sizeof(nl));
			nl.nl_family = AF_NETLINK;
			memcpy(addr, &nl, *alen < sizeof(nl) ? *alen : sizeof(nl));
			*alen = sizeof(nl);
		}
		if (!(flags & MSG_PEEK)) {
			head = p->next;
			if (!head)
				tail = NULL;
			free(p);
		}
		return (ssize_t)n;
	}
	return real(fd, buf, len, flags, addr, alen);
}

int poll(struct pollfd *fds, nfds_t nfds, int timeout)
{
	int (*real)(struct pollfd *, nfds_t, int) = dlsym(RTLD_NEXT, "poll");
	nfds_t i;
	if (fake_fd >= 0) {
		for (i = 0; i < nfds; i++)
			if (fds[i].fd == fake_fd) {
				fds[i].revents = head ? POLLIN : 0;
				return head ? 1 : 0;
			}
	}
	return real(fds, nfds, timeout);
}

int select(int n, fd_set *r, fd_set *w, fd_set *e, struct timeval *t)
{
	int (*real)(int, fd_set *, fd_set *, fd_set *, struct timeval *) = dlsym(RTLD_NEXT, "select");
	if (fake_fd >= 0 && r && FD_ISSET(fake_fd, r))
		return head ? 1 : 0;
	return real(n, r, w, e, t);
}

int close(int fd)
{
	int (*real)(int) = dlsym(RTLD_NEXT, "close");
	if (fd == fake_fd && fd >= 0) {
		int rc = real(fd);
		fake_fd = -1;
		while (head) {
			struct pending *p = head;
			head = p->next;
			free(p);
		}
		tail = NULL;
		return rc;
	}
	return real(fd);
}
