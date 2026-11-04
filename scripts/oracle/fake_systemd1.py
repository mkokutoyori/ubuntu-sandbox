#!/usr/bin/env python3
"""A one-property-set stand-in for the systemd manager on a private D-Bus, enough for hostnamectl.

usage: fake_systemd1.py ADDRESS_PATH VIRTUALIZATION ARCHITECTURE

hostnamectl status asks org.freedesktop.systemd1 (/org/freedesktop/systemd1) for the two properties the manager alone knows, Virtualization and Architecture, with a Properties.GetAll("")
call; systemd-hostnamed, the real daemon, answers everything else. The sandbox the recordings are made in has no PID 1 systemd, so this process owns the name org.freedesktop.systemd1 on the
private bus of record_hostnamectl.py and answers GetAll with the two strings given on the command line. It speaks the D-Bus wire protocol (little endian, EXTERNAL authentication) by itself,
with the standard library only.
"""
import os, socket, struct, sys


def pad(buffer, alignment):
    while len(buffer) % alignment:
        buffer.append(0)


def string(value):
    data = value.encode()
    return struct.pack("<I", len(data)) + data + b"\0"


def message(kind, serial, fields, signature, body):
    out = bytearray()
    header_fields = bytearray()
    for code, sig, value in fields:
        pad(header_fields, 8)
        header_fields.append(code)
        header_fields.append(len(sig))
        header_fields += sig.encode() + b"\0"
        if sig in ("s", "o"):
            pad(header_fields, 4)
            header_fields += string(value)
        elif sig == "u":
            pad(header_fields, 4)
            header_fields += struct.pack("<I", value)
        elif sig == "g":
            header_fields.append(len(value))
            header_fields += value.encode() + b"\0"
    if signature:
        pad(header_fields, 8)
        header_fields.append(8)
        header_fields += bytes([1]) + b"g\0"
        header_fields.append(len(signature))
        header_fields += signature.encode() + b"\0"
    out += struct.pack("<BBBBIII", ord("l"), kind, 0, 1, len(body), serial, len(header_fields))
    out += header_fields
    pad(out, 8)
    out += body
    return bytes(out)


def read_exact(connection, count):
    data = b""
    while len(data) < count:
        chunk = connection.recv(count - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data


def read_message(connection):
    head = read_exact(connection, 16)
    endian, kind, flags, version, body_length, serial, fields_length = struct.unpack("<BBBBIII", head)
    fields = read_exact(connection, fields_length)
    padding = (8 - (16 + fields_length) % 8) % 8
    if padding:
        read_exact(connection, padding)
    body = read_exact(connection, body_length)
    found = {}
    offset = 0
    while offset < len(fields):
        offset = (offset + 7) // 8 * 8
        if offset >= len(fields):
            break
        code = fields[offset]
        signature_length = fields[offset + 1]
        signature = fields[offset + 2: offset + 2 + signature_length].decode()
        offset += 3 + signature_length
        if signature in ("s", "o"):
            offset = (offset + 3) // 4 * 4
            length = struct.unpack_from("<I", fields, offset)[0]
            found[code] = fields[offset + 4: offset + 4 + length].decode()
            offset += 5 + length
        elif signature == "u":
            offset = (offset + 3) // 4 * 4
            found[code] = struct.unpack_from("<I", fields, offset)[0]
            offset += 4
        elif signature == "g":
            length = fields[offset]
            found[code] = fields[offset + 1: offset + 1 + length].decode()
            offset += 2 + length
    return kind, serial, found, body


def call(connection, serial, destination, path, interface, member, signature="", body=b""):
    fields = [(1, "o", path), (6, "s", destination), (2, "s", interface), (3, "s", member)]
    connection.sendall(message(1, serial, fields, signature, body))


def reply_for(connection, serial, request, reply_serial_of, signature, body):
    fields = [(5, "u", request), (6, "s", reply_serial_of)]
    connection.sendall(message(2, serial, fields, signature, body))


def get_all_reply(properties):
    entries = bytearray()
    for key, value in properties.items():
        pad(entries, 8)
        entries += string(key)
        entries += bytes([1]) + b"s\0"
        pad(entries, 4)
        entries += string(value)
    body = bytearray(struct.pack("<I", len(entries)))
    pad(body, 8)
    body += entries
    return bytes(body)


def main():
    path, virtualization, architecture = sys.argv[1], sys.argv[2], sys.argv[3]
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(path)
    connection.sendall(b"\0AUTH EXTERNAL " + str(os.getuid()).encode().hex().encode() + b"\r\n")
    answer = b""
    while not answer.endswith(b"\r\n"):
        answer += connection.recv(1)
    connection.sendall(b"BEGIN\r\n")
    serial = 1
    call(connection, serial, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello")
    read_message(connection)
    serial += 1
    request = bytearray(string("org.freedesktop.systemd1"))
    pad(request, 4)
    request += struct.pack("<I", 0)
    call(connection, serial, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", "su", bytes(request))
    read_message(connection)
    properties = {"Virtualization": virtualization, "Architecture": architecture}
    print("ready", flush=True)
    while True:
        kind, request_serial, fields, body = read_message(connection)
        if kind != 1:
            continue
        serial += 1
        if fields.get(3) == "GetAll":
            reply_for(connection, serial, request_serial, fields.get(7, ""), "a{sv}", get_all_reply(properties))


if __name__ == "__main__":
    try:
        main()
    except (EOFError, ConnectionError):
        pass
