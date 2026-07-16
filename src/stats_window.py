import math
from typing import List


class RollingWindow:
    """Fixed-size rolling window for numeric samples."""

    def __init__(self, size: int = 30):
        self._size = size
        self._values: List[float] = []

    def add(self, value: float) -> None:
        self._values.append(value)
        if len(self._values) > self._size:
            self._values.pop(0)

    @property
    def count(self) -> int:
        return len(self._values)

    def stddev(self) -> float:
        if len(self._values) < 2:
            return 0.0
        mean = sum(self._values) / len(self._values)
        variance = sum((value - mean) ** 2 for value in self._values) / len(self._values)
        return math.sqrt(variance)

    def coefficient_of_variation(self) -> float:
        if len(self._values) < 2:
            return 0.0
        mean = sum(self._values) / len(self._values)
        if mean == 0:
            return 0.0
        return self.stddev() / mean
