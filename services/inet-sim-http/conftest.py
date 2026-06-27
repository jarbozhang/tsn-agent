"""把服务根目录加入 sys.path，让 tests 能 `import config/preflight/runner/app`（扁平布局）。"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
