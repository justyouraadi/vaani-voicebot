import sys
sys.path.insert(0, "coqpit_config-0.2.5")
from coqpit import Coqpit
from typing import Union

class MyConfig(Coqpit):
    my_field: Union[int, str] = 5

c = MyConfig()
print("Serialized:", c.to_dict())
