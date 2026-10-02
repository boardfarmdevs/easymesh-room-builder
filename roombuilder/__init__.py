"""EasyMesh room builder.

A standalone designer for ``wmdcfg`` Golden World rooms: floor plans, walls,
mesh agents, clients and movement scenarios that compile to exactly the same
``wmdcfg.world-plan.v1`` artifacts as the reference configurator.
"""

__version__ = "1.0.0"

# The configurator revision whose semantics the ported modules reproduce.
REFERENCE_PROJECT = "boardfarmdevs/easymesh-medium"
REFERENCE_PATH = "configurator"
