"""Lightweight fallback shim for pymeshlab when C++/Qt binaries are omitted in bundled runtime."""

from __future__ import annotations
from typing import Any


class MeshSet:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._meshes: list[Any] = []

    def load_new_mesh(self, *args: Any, **kwargs: Any) -> None:
        pass

    def current_mesh(self) -> Any:
        return self

    def face_number(self) -> int:
        return 0

    def add_mesh(self, *args: Any, **kwargs: Any) -> None:
        pass

    def meshing_decimation_quadric_edge_collapse(self, *args: Any, **kwargs: Any) -> None:
        pass


class Mesh:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass


def PercentageValue(val: Any) -> Any:
    return val
