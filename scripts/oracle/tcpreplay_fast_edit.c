
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
typedef unsigned long long COUNTER;
static void edit(uint32_t src_ip_in, uint32_t dst_ip_in, COUNTER iteration, bool cached, uint32_t *out_src, uint32_t *out_dst) {
    uint32_t src_ip = src_ip_in, dst_ip = dst_ip_in;
    uint32_t src_ip_orig = src_ip_in, dst_ip_orig = dst_ip_in;
    
    if ((!cached && dst_ip > src_ip) || (cached && (dst_ip - iteration) > (src_ip - 1 - iteration))) {
        if (cached) {
            --src_ip;
            ++dst_ip;
        } else {
            src_ip -= iteration;
            dst_ip += iteration;
        }

        if (src_ip > src_ip_orig && dst_ip > dst_ip_orig) {
            
            --src_ip;
            
        } else if (dst_ip < dst_ip_orig && src_ip < src_ip_orig) {
            
            ++dst_ip;
            
        }
    } else {
        if (cached) {
            ++src_ip;
            --dst_ip;
        } else {
            src_ip += iteration;
            dst_ip -= iteration;
        }

        if (dst_ip > dst_ip_orig && src_ip > src_ip_orig) {
            
            --dst_ip;
            
        } else if (src_ip < src_ip_orig && dst_ip < dst_ip_orig) {
            
            ++src_ip;
            
        }
    }

    *out_src = src_ip; *out_dst = dst_ip;
}
int main(void) {
    uint32_t values[] = {0, 1, 2, 3, 0x0a000001u, 0x0a000002u, 0x7fffffffu, 0x80000000u, 0xfffffffeu, 0xffffffffu, 0xc0a80101u, 0xc0a80102u, 0x00000100u};
    int n = sizeof(values) / sizeof(values[0]);
    uint64_t iterations[] = {0, 1, 2, 3, 7, 255, 65535, 0x7fffffffu, 0xffffffffu, 0x100000000ull, 5000000000ull};
    int m = sizeof(iterations) / sizeof(iterations[0]);
    printf("[");
    int first = 1;
    for (int s = 0; s < n; s++) for (int d = 0; d < n; d++) for (int i = 0; i < m; i++) for (int c = 0; c < 2; c++) {
        uint32_t os, od;
        edit(values[s], values[d], iterations[i], c, &os, &od);
        printf("%s[%u,%u,%llu,%d,%u,%u]", first ? "" : ",", values[s], values[d], (unsigned long long)iterations[i], c, os, od);
        first = 0;
    }
    printf("]\n");
    return 0;
}
