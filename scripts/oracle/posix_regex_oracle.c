#define _GNU_SOURCE
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <locale.h>

static char *unhex(const char *h) {
	size_t n = strlen(h) / 2;
	char *out = malloc(n + 1);
	for (size_t i = 0; i < n; i++) {
		unsigned v;
		sscanf(h + 2 * i, "%2x", &v);
		out[i] = (char)v;
	}
	out[n] = 0;
	return out;
}

int main(void) {
	setlocale(LC_ALL, "C.UTF-8");
	char flags[16], hp[8192], ht[8192];
	long start;
	while (scanf("%15s %8191s %8191s %ld", flags, hp, ht, &start) == 4) {
		char *pat = strcmp(hp, "-") ? unhex(hp) : strdup("");
		char *txt = strcmp(ht, "-") ? unhex(ht) : strdup("");
		regex_t re;
		int cflags = REG_EXTENDED | (strchr(flags, 'i') ? REG_ICASE : 0);
		int rc = regcomp(&re, pat, cflags);
		if (rc != 0) {
			char msg[256];
			regerror(rc, &re, msg, sizeof msg);
			printf("ERR %s\n", msg);
			free(pat); free(txt);
			continue;
		}
		regmatch_t m[10];
		m[0].rm_so = start;
		m[0].rm_eo = strlen(txt);
		rc = regexec(&re, txt, 10, m, REG_STARTEND);
		if (rc != 0) {
			printf("NOMATCH\n");
		} else {
			printf("OK");
			for (int i = 0; i < 10; i++) printf(" %d,%d", (int)m[i].rm_so, (int)m[i].rm_eo);
			printf("\n");
		}
		regfree(&re);
		free(pat); free(txt);
	}
	return 0;
}
