"""Where the FLEX Field tests keep their files: $FF_WORK, or a folder in the
system temp directory. run_all.py fills it (synthetic export, a note page)."""
import os, tempfile
WORK = os.environ.get('FF_WORK') or os.path.join(tempfile.gettempdir(), 'flexfield-tests')
os.makedirs(os.path.join(WORK, 'shots'), exist_ok=True)
