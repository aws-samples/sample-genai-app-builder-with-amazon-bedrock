"""
Pytest configuration for the brand-templates Lambda tests.

The Lambda runs with its package directory on sys.path so that modules can
import each other with flat `from schema import ...` style. We replicate that
layout in tests by adding the parent directory to sys.path before the test
modules are collected.
"""

from __future__ import annotations

import sys
from pathlib import Path

_LAMBDA_ROOT = Path(__file__).resolve().parent.parent

if str(_LAMBDA_ROOT) not in sys.path:
    sys.path.insert(0, str(_LAMBDA_ROOT))
