#!/usr/bin/env python3
"""Record curl_easy_strerror of the installed libcurl for every CURLcode.

usage: record_curl_strerror.py messages.json
"""
import ctypes, json, sys

lib = ctypes.CDLL("libcurl.so.4")
lib.curl_easy_strerror.restype = ctypes.c_char_p
lib.curl_easy_strerror.argtypes = [ctypes.c_int]
lib.curl_version.restype = ctypes.c_char_p

messages = {str(code): lib.curl_easy_strerror(code).decode() for code in range(0, 110)}
messages["unknown"] = lib.curl_easy_strerror(999).decode()
with open(sys.argv[1], "w") as handle:
    json.dump({"library": lib.curl_version().decode().split(" ")[0], "messages": messages}, handle, indent=1)
