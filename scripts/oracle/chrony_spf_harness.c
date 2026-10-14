#include "config.h"
#include "sysincl.h"
#include "samplefilt.h"
#include "memory.h"
#include "logging.h"
int log_min_severity = 5;
void LOG_Message(LOG_Severity s, const char *f, ...) {}
double LCL_GetSysPrecisionAsQuantum(void) { return 1.0e-9; }
void LCL_ReadCookedTime(struct timespec *ts, double *err) {}
#include "hash.h"
HSH_Algorithm dummy_alg;
int HSH_GetHashId(HSH_Algorithm a) { return 0; }
int HSH_Hash(int id, const void *a, int al, const void *b, int bl, unsigned char *out, int ol) { return 0; }
int main(int argc, char **argv) {
  int length = argc > 1 ? atoi(argv[1]) : 4;
  SPF_Instance f = SPF_CreateInstance(1, length, 16.0, 0.0);
  char line[512];
  int count = 0;
  while (fgets(line, sizeof line, stdin)) {
    double t, off, pd, pdisp, rd, rdisp;
    if (sscanf(line, "%lf %lf %lf %lf %lf %lf", &t, &off, &pd, &pdisp, &rd, &rdisp) != 6) continue;
    NTP_Sample smp; memset(&smp, 0, sizeof smp);
    smp.time.tv_sec = (time_t)t; smp.time.tv_nsec = (long)((t - (double)(time_t)t) * 1e9);
    smp.offset = off; smp.peer_delay = pd; smp.peer_dispersion = pdisp; smp.root_delay = rd; smp.root_dispersion = rdisp;
    SPF_AccumulateSample(f, &smp);
    if (++count < SPF_GetMaxSamples(f)) continue;
    NTP_Sample out;
    if (SPF_GetFilteredSample(f, &out)) {
      printf("%ld.%09ld %.12e %.12e %.12e %.12e %.12e\n", (long)out.time.tv_sec, out.time.tv_nsec, out.offset, out.peer_delay, out.peer_dispersion, out.root_delay, out.root_dispersion);
      count = 0;
    } else printf("none\n");
  }
  return 0;
}
