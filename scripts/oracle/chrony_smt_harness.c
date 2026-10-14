#include "config.h"
#include "sysincl.h"
#include "smooth.h"
#include "local.h"
#include "reference.h"
#include "conf.h"
#include "reports.h"
#include "logging.h"
#include "util.h"
int log_min_severity = 5;
void LOG_Message(LOG_Severity s, const char *f, ...) {}
static LCL_ParameterChangeHandler handler;
static double skew = 1e-9;
void CNF_GetSmooth(double *max_freq, double *max_wander, int *leap_only) {
  *max_freq = 400.0; *max_wander = 0.5; *leap_only = 0;
  char *e = getenv("SMT_LEAPONLY"); if (e) *leap_only = atoi(e);
  e = getenv("SMT_MAXFREQ"); if (e) *max_freq = atof(e);
  e = getenv("SMT_MAXWANDER"); if (e) *max_wander = atof(e);
}
void LCL_AddParameterChangeHandler(LCL_ParameterChangeHandler h, void *a) { handler = h; }
void LCL_RemoveParameterChangeHandler(LCL_ParameterChangeHandler h, void *a) {}
double REF_GetSkew(void) { return skew; }
static struct timespec at(double t) { struct timespec ts; ts.tv_sec = (time_t)t; ts.tv_nsec = (long)((t - (double)(time_t)t) * 1e9); return ts; }
int main(void) {
  char cmd[32], line[256];
  SMT_Initialise();
  while (fgets(line, sizeof line, stdin)) {
    double a, b, c;
    int n = sscanf(line, "%31s %lf %lf %lf", cmd, &a, &b, &c);
    if (n < 1) continue;
    struct timespec now = at(a);
    if (!strcmp(cmd, "skew")) skew = a;
    else if (!strcmp(cmd, "adjust")) { struct timespec raw = now; handler(&raw, &now, c, b, LCL_ChangeAdjust, NULL); }
    else if (!strcmp(cmd, "activate")) SMT_Activate(&now);
    else if (!strcmp(cmd, "reset")) SMT_Reset(&now);
    else if (!strcmp(cmd, "leap")) SMT_Leap(&now, (int)b);
    else if (!strcmp(cmd, "offset")) printf("%.12e\n", SMT_GetOffset(&now));
    else if (!strcmp(cmd, "report")) {
      RPT_SmoothingReport r;
      if (SMT_GetSmoothingReport(&r, &now)) printf("%d %d %.12e %.12e %.12e %.12e %.12e\n", r.active, r.leap_only, r.offset, r.freq_ppm, r.wander_ppm, r.last_update_ago, r.remaining_time);
    }
  }
  return 0;
}
void LCL_ReadCookedTime(struct timespec *ts, double *err) {}
#include "hash.h"
HSH_Algorithm dummy_alg;
int HSH_GetHashId(HSH_Algorithm a) { return 0; }
int HSH_Hash(int id, const void *a, int al, const void *b, int bl, unsigned char *out, int ol) { return 0; }
