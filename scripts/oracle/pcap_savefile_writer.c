/* usage: gcc pcap_savefile_writer.c -o pcap_savefile_writer -lpcap && ./pcap_savefile_writer micro|nano DLT SNAPLEN OUT < records
 * Each stdin line is "SECONDS SUBSECOND ORIGINAL_LENGTH HEXDATA"; the file is written by the real pcap_dump so the codec's bytes
 * can be compared with the library's own. */
#include <pcap/pcap.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  u_int precision = strcmp(argv[1], "nano") == 0 ? PCAP_TSTAMP_PRECISION_NANO : PCAP_TSTAMP_PRECISION_MICRO;
  pcap_t *dead = pcap_open_dead_with_tstamp_precision(atoi(argv[2]), atoi(argv[3]), precision);
  pcap_dumper_t *dump = pcap_dump_open(dead, argv[4]);
  if (dump == NULL) return 1;
  char line[1 << 20];
  while (fgets(line, sizeof line, stdin)) {
    long seconds, subsecond;
    unsigned originalLength;
    char hex[1 << 19];
    hex[0] = 0;
    if (sscanf(line, "%ld %ld %u %s", &seconds, &subsecond, &originalLength, hex) < 3) continue;
    unsigned char data[1 << 18];
    unsigned length = strlen(hex) / 2;
    for (unsigned i = 0; i < length; i++) { unsigned v; sscanf(hex + 2 * i, "%2x", &v); data[i] = (unsigned char)v; }
    struct pcap_pkthdr header;
    header.ts.tv_sec = seconds;
    header.ts.tv_usec = subsecond;
    header.caplen = length;
    header.len = originalLength;
    pcap_dump((u_char *)dump, &header, data);
  }
  pcap_dump_close(dump);
  pcap_close(dead);
  return 0;
}
