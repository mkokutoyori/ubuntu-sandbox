#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <yaml.h>

static void text(const char *name, const unsigned char *value, size_t length)
{
    printf("\"%s\":\"", name);
    for (size_t index = 0; index < length; index++) {
        unsigned char c = value[index];
        if (c < 0x20 || c == '"' || c == '\\') printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}

static void optional(const char *name, const unsigned char *value)
{
    if (value) {
        putchar(',');
        text(name, value, strlen((const char *)value));
    } else printf(",\"%s\":null", name);
}

static void mark(const char *name, yaml_mark_t m)
{
    printf(",\"%s\":[%zu,%zu,%zu]", name, m.index, m.line, m.column);
}

static const char *scalar_style(yaml_scalar_style_t style)
{
    switch (style) {
    case YAML_PLAIN_SCALAR_STYLE: return "plain";
    case YAML_SINGLE_QUOTED_SCALAR_STYLE: return "single-quoted";
    case YAML_DOUBLE_QUOTED_SCALAR_STYLE: return "double-quoted";
    case YAML_LITERAL_SCALAR_STYLE: return "literal";
    case YAML_FOLDED_SCALAR_STYLE: return "folded";
    default: return "any";
    }
}

int main(int argc, char **argv)
{
    FILE *file = fopen(argv[1], "rb");
    yaml_parser_t parser;
    yaml_event_t event;
    yaml_parser_initialize(&parser);
    yaml_parser_set_input_file(&parser, file);
    for (;;) {
        if (!yaml_parser_parse(&parser, &event)) {
            const char *kind = parser.error == YAML_READER_ERROR ? "reader" : parser.error == YAML_SCANNER_ERROR ? "scanner" : "parser";
            printf("{\"t\":\"error\",\"kind\":\"%s\"", kind);
            optional("problem", (const unsigned char *)parser.problem);
            optional("context", (const unsigned char *)parser.context);
            if (parser.error == YAML_READER_ERROR) printf(",\"offset\":%zu,\"value\":%d", parser.problem_offset, parser.problem_value);
            else {
                mark("problemMark", parser.problem_mark);
                if (parser.context) mark("contextMark", parser.context_mark);
            }
            printf("}\n");
            break;
        }
        printf("{");
        switch (event.type) {
        case YAML_STREAM_START_EVENT: printf("\"t\":\"stream-start\""); break;
        case YAML_STREAM_END_EVENT: printf("\"t\":\"stream-end\""); break;
        case YAML_DOCUMENT_START_EVENT:
            printf("\"t\":\"document-start\",\"implicit\":%d", event.data.document_start.implicit);
            if (event.data.document_start.version_directive)
                printf(",\"version\":[%d,%d]", event.data.document_start.version_directive->major, event.data.document_start.version_directive->minor);
            else printf(",\"version\":null");
            printf(",\"tags\":[");
            for (yaml_tag_directive_t *d = event.data.document_start.tag_directives.start; d != event.data.document_start.tag_directives.end; d++) {
                if (d != event.data.document_start.tag_directives.start) putchar(',');
                printf("{");
                text("handle", d->handle, strlen((char *)d->handle));
                putchar(',');
                text("prefix", d->prefix, strlen((char *)d->prefix));
                printf("}");
            }
            printf("]");
            break;
        case YAML_DOCUMENT_END_EVENT: printf("\"t\":\"document-end\",\"implicit\":%d", event.data.document_end.implicit); break;
        case YAML_ALIAS_EVENT:
            printf("\"t\":\"alias\",");
            text("anchor", event.data.alias.anchor, strlen((char *)event.data.alias.anchor));
            break;
        case YAML_SCALAR_EVENT:
            printf("\"t\":\"scalar\",");
            text("value", event.data.scalar.value, event.data.scalar.length);
            optional("anchor", event.data.scalar.anchor);
            optional("tag", event.data.scalar.tag);
            printf(",\"plain\":%d,\"quoted\":%d,\"style\":\"%s\"", event.data.scalar.plain_implicit, event.data.scalar.quoted_implicit, scalar_style(event.data.scalar.style));
            break;
        case YAML_SEQUENCE_START_EVENT:
            printf("\"t\":\"sequence-start\"");
            optional("anchor", event.data.sequence_start.anchor);
            optional("tag", event.data.sequence_start.tag);
            printf(",\"implicit\":%d,\"style\":\"%s\"", event.data.sequence_start.implicit, event.data.sequence_start.style == YAML_FLOW_SEQUENCE_STYLE ? "flow" : "block");
            break;
        case YAML_SEQUENCE_END_EVENT: printf("\"t\":\"sequence-end\""); break;
        case YAML_MAPPING_START_EVENT:
            printf("\"t\":\"mapping-start\"");
            optional("anchor", event.data.mapping_start.anchor);
            optional("tag", event.data.mapping_start.tag);
            printf(",\"implicit\":%d,\"style\":\"%s\"", event.data.mapping_start.implicit, event.data.mapping_start.style == YAML_FLOW_MAPPING_STYLE ? "flow" : "block");
            break;
        case YAML_MAPPING_END_EVENT: printf("\"t\":\"mapping-end\""); break;
        default: printf("\"t\":\"none\""); break;
        }
        mark("s", event.start_mark);
        mark("e", event.end_mark);
        printf("}\n");
        if (event.type == YAML_STREAM_END_EVENT) {
            yaml_event_delete(&event);
            break;
        }
        yaml_event_delete(&event);
    }
    yaml_parser_delete(&parser);
    fclose(file);
    return 0;
}
