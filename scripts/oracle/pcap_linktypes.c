#include <pcap/pcap.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
/* usage: gcc pcap_linktypes.c -o pcap_linktypes -lpcap && ./pcap_linktypes > linktypes.tsv
 * One line per DLT the installed libpcap names: LINKTYPE (the value a savefile header carries), DLT, name, description. */
int main(void) {
  for (int dlt = 0; dlt < 400; dlt++) {
    const char *name = pcap_datalink_val_to_name(dlt);
    if (name == NULL) continue;
    const char *description = pcap_datalink_val_to_description(dlt);
    pcap_t *dead = pcap_open_dead(dlt, 65535);
    if (dead == NULL) continue;
    pcap_dumper_t *dump = pcap_dump_open(dead, "/tmp/pcap_linktypes_probe.pcap");
    if (dump == NULL) { pcap_close(dead); continue; }
    pcap_dump_close(dump);
    FILE *f = fopen("/tmp/pcap_linktypes_probe.pcap", "rb");
    uint8_t header[24];
    if (fread(header, 1, 24, f) != 24) { fclose(f); pcap_close(dead); continue; }
    fclose(f);
    uint32_t linktype; memcpy(&linktype, header + 20, 4);
    printf("%u\t%d\t%s\t%s\n", linktype, dlt, name, description);
    pcap_close(dead);
  }
  return 0;
}
