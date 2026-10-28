/* usage: gcc pcap_savefile_reader.c -o pcap_savefile_reader -lpcap && ./pcap_savefile_reader file...
 * Prints one JSON object per file: what the real libpcap says opening it with nanosecond precision and reading every
 * packet, so the failure texts and the scaled time stamps are the library's own. */
#include <pcap/pcap.h>
#include <stdio.h>
#include <string.h>

static void hex(const unsigned char *data, unsigned length) {
  for (unsigned i = 0; i < length; i++) printf("%02x", data[i]);
}

static void quoted(const char *text) {
  putchar('"');
  for (const char *c = text; *c; c++) {
    if (*c == '"' || *c == '\\') putchar('\\');
    putchar(*c);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    char errbuf[PCAP_ERRBUF_SIZE];
    printf("{\"file\":");
    quoted(argv[i]);
    pcap_t *p = pcap_open_offline_with_tstamp_precision(argv[i], PCAP_TSTAMP_PRECISION_NANO, errbuf);
    if (p == NULL) {
      printf(",\"openError\":");
      quoted(errbuf);
      printf("}\n");
      continue;
    }
    const char *dltName = pcap_datalink_val_to_name(pcap_datalink(p));
    printf(",\"dlt\":%d,\"name\":", pcap_datalink(p));
    if (dltName == NULL) printf("null"); else quoted(dltName);
    printf(",\"snapshot\":%d,\"major\":%d,\"minor\":%d,\"swapped\":%d,\"records\":[",
           pcap_snapshot(p), pcap_major_version(p), pcap_minor_version(p), pcap_is_swapped(p));
    struct pcap_pkthdr *header;
    const unsigned char *data;
    int status;
    int first = 1;
    while ((status = pcap_next_ex(p, &header, &data)) == 1) {
      if (!first) putchar(',');
      first = 0;
      printf("{\"sec\":%ld,\"nsec\":%ld,\"caplen\":%u,\"len\":%u,\"data\":\"", (long)header->ts.tv_sec, (long)header->ts.tv_usec, header->caplen, header->len);
      hex(data, header->caplen);
      printf("\"}");
    }
    printf("],\"readError\":");
    if (status == PCAP_ERROR) quoted(pcap_geterr(p)); else printf("null");
    printf("}\n");
    pcap_close(p);
  }
  return 0;
}
