from app.models.user import User
from app.config import SETTINGS
from . import helpers
from ..config import SETTINGS as CFG
from app.missing import Ghost
import requests


class UserService:
    default_domain = "acme.test"

    def __init__(self, store):
        self.store = store
        self._cache = {}

    def find(self, name):
        if name in self._cache:
            return self._cache[name]
        for row in self.store.all():
            if row.name == name:
                self._cache[name] = User(row.name, row.email)
                return self.normalise(self._cache[name])
        return None

    def normalise(self, user):
        return helpers.trim(user)


def build(store):
    return UserService(store)
