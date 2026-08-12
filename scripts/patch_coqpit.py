#!/usr/bin/env python3
"""
🩹 Coqpit Python 3.11 Full Compatibility Patch
Fixes all Coqpit deserialization bugs on Python 3.11 / Python 3.10+
"""

import os
import re
import sys

def patch_coqpit():
    path = "/workspace/venv/lib/python3.11/site-packages/coqpit/coqpit.py"
    if not os.path.exists(path):
        print(f"[WARN] {path} not found — skipping patch")
        return

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Fix missing quotes around UnionType in coqpit.py
    content = content.replace(
        'getattr(types, UnionType, None)',
        'getattr(types, "UnionType", None)'
    )

    # 2. Fix safe_issubclass (prevents TypeError when checking generic types)
    content = re.sub(
        r'(?s)def safe_issubclass\(cls, classinfo\).*?return False\s*',
        '',
        content
    )
    content = content.replace('safe_issubclass', 'issubclass')

    safe_func = """

def safe_issubclass(cls, classinfo) -> bool:
    try:
        return issubclass(cls, classinfo)
    except TypeError:
        return False
"""
    content = content + safe_func

    for target in [
        'issubclass(type(x), Serializable)',
        'issubclass(x, Serializable)',
        'issubclass(base_type, Serializable)',
    ]:
        content = content.replace(target, 'safe_' + target)

    content = content.replace('safe_safe_issubclass', 'safe_issubclass')

    # 3. Patch is_union() to support Python 3.10+ types.UnionType (| syntax)
    new_is_union = """def is_union(arg_type: Any) -> bool:
    try:
        import types as _types
        origin = getattr(arg_type, "__origin__", None)
        if origin is getattr(_types, "UnionType", None):
            return True
        return safe_issubclass(origin, Union)
    except Exception:
        return False"""

    content = re.sub(
        r'(?s)def is_union\(arg_type: Any\) -> bool:.*?return False',
        new_is_union,
        content
    )

    # 4. Patch _deserialize_primitive_types to raise ValueError when x is not primitive
    old_primitive = """    if isinstance(x, (str, bool)):
        return x
    if isinstance(x, (int, float)):
        if x == float("inf") or x == float("-inf"):
            # if value type is inf return regardless.
            return x
        x = field_type(x)
        return x"""

    new_primitive = """    if isinstance(x, (str, bool)):
        return x
    if isinstance(x, (int, float)):
        if x == float("inf") or x == float("-inf"):
            # if value type is inf return regardless.
            return x
        x = field_type(x)
        return x
    raise ValueError(f"Expected primitive type {field_type}, got {type(x)}")"""

    content = content.replace(old_primitive, new_primitive)

    # 5. Patch _deserialize_union to handle None and catch TypeError/AttributeError
    old_union = """    for arg in field_type.__args__:
        # stop after first matching type in Union
        try:
            x = _deserialize(x, arg)
            break
        except ValueError:
            pass
    return x"""

    new_union = """    if x is None:
        return None
    for arg in getattr(field_type, "__args__", []):
        if arg is type(None) or arg is None or str(arg) == "<class 'NoneType'>":
            if x is None:
                return None
            continue
        try:
            res = _deserialize(x, arg)
            if res is not None:
                return res
        except (ValueError, TypeError, AttributeError):
            pass
    if x is None:
        return None
    raise ValueError(f" [!] '{type(x)}' value type of '{x}' does not match '{field_type}' field type.")"""

    content = content.replace(old_union, new_union)

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

    print("✅ coqpit.py successfully patched for Python 3.11!")

if __name__ == "__main__":
    patch_coqpit()
