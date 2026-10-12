#include <stdlib.h>
#include <time.h>

time_t time(time_t *out)
{
	const char *value = getenv("FAKE_NOW");
	time_t now = value ? (time_t)strtol(value, NULL, 10) : 0;
	if (out)
		*out = now;
	return now;
}
