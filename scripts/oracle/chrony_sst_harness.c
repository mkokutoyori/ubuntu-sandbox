#include "config.h"
#include "sysincl.h"
#include "sourcestats.h"
#include "reports.h"
#include "memory.h"
#include "logging.h"
int log_min_severity = 5;
void LOG_Message(LOG_Severity s, const char *f, ...) {}
LOG_FileID LOG_FileOpen(const char *n, const char *h) { return -1; }
void LOG_FileWrite(LOG_FileID id, const char *f, ...) {}
int CNF_GetLogStatistics(void) { return 0; }
double CNF_GetMaxJitter(void) { return 10.0; }
double LCL_GetSysPrecisionAsQuantum(void) { return 1.0e-9; }
int main(int argc, char **argv) {
  double prec = 1e-9;
  SST_Stats s = SST_CreateInstance(0x7f000002, NULL, 1, 0, 0.0, 0.0);
  char line[512];
  while (fgets(line, sizeof line, stdin)) {
    double t, off, pd, pdisp, rd, rdisp;
    if (sscanf(line, "%lf %lf %lf %lf %lf %lf", &t, &off, &pd, &pdisp, &rd, &rdisp) != 6) continue;
    NTP_Sample smp; memset(&smp, 0, sizeof smp);
    smp.time.tv_sec = (time_t)t; smp.time.tv_nsec = (long)((t - (double)(time_t)t) * 1e9);
    smp.offset = off; smp.peer_delay = pd; smp.peer_dispersion = pdisp; smp.root_delay = rd; smp.root_dispersion = rdisp;
    SST_AccumulateSample(s, &smp);
    SST_DoNewRegression(s);
    struct timespec now = smp.time;
    RPT_SourcestatsReport r;
    SST_DoSourcestatsReport(s, &r, &now);
    double ol, oh, rdist, sd, fa, la; int ok;
    SST_GetSelectionData(s, &now, &ol, &oh, &rdist, &sd, &fa, &la, &ok);
    printf("%lu %lu %ld %.12e %.12e %.12e %.12e %.12e %.12e %.12e %d\n", r.n_samples, r.n_runs, (long)r.span_seconds, r.est_offset, r.est_offset_err, r.resid_freq_ppm, r.skew_ppm, r.sd, ol, oh, ok);
  }
  return 0;
}
void LCL_ReadCookedTime(struct timespec *ts, double *err) {}
#include "hash.h"
HSH_Algorithm dummy_alg;
int HSH_GetHashId(HSH_Algorithm a) { return 0; }
int HSH_Hash(int id, const void *a, int al, const void *b, int bl, unsigned char *out, int ol) { return 0; }
