import os
from dataclasses import dataclass


@dataclass
class User:
    name: str
    email: str = ""

    def domain(self):
        return self.email.split("@")[-1]
