print("=" * 50)
print("  PYTHON SIMULATOR - TEST SUITE")
print("=" * 50)
print()

# 1. Basic Operations
print("[1] BASIC PYTHON")
print("-" * 30)
jours = ["lundi", "mardi", "mercredi", "jeudi"]
print("Liste:", jours)
print("Len:", len(jours))
print("First:", jours[0])

for i in range(3):
    print("Loop:", i)

carres = [x*x for x in range(5)]
print("Squares:", carres)
print()

# 2. OS Module
print("[2] OS MODULE")
print("-" * 30)
import os
print("cwd:", os.getcwd())
print("user:", os.getlogin())
print("HOME:", os.getenv("HOME"))
print("listdir:", os.listdir())

print("exists .:", os.path.exists("."))
print("isdir .:", os.path.isdir("."))
print()

# 3. mkdir/rmdir test
print("[3] MKDIR/RMDIR")
print("-" * 30)
os.mkdir("test_dir")
print("Created test_dir")
print("Exists:", os.path.exists("test_dir"))
os.rmdir("test_dir")
print("Removed test_dir")
print()

# 4. Math Module
print("[4] MATH MODULE")
print("-" * 30)
import math
print("pi:", math.pi)
print("sqrt(16):", math.sqrt(16))
print("floor(3.7):", math.floor(3.7))
print()

# 5. Random Module
print("[5] RANDOM MODULE")
print("-" * 30)
import random
print("random:", random.random())
print("randint:", random.randint(1, 100))
print()

# 6. String Operations
print("[6] STRINGS")
print("-" * 30)
s = "Hello World"
print("upper:", s.upper())
print("lower:", s.lower())
print("split:", s.split())
print()

# 7. Dict and Functions
print("[7] DICT & FUNCTIONS")
print("-" * 30)
d = {"a": 1, "b": 2}
print("dict:", d)
print("keys:", list(d.keys()))

def greet(name):
    return "Hi " + name

print("func:", greet("Python"))
print()

# 8. Built-ins
print("[8] BUILT-INS")
print("-" * 30)
print("sum:", sum([1,2,3,4,5]))
print("min:", min([5,2,8]))
print("max:", max([5,2,8]))
print("sorted:", sorted([3,1,4,1,5]))
print("len:", len("hello"))
print("type:", type([]))
print("range:", list(range(5)))
print()

print("=" * 50)
print("  ALL TESTS PASSED!")
print("=" * 50)
