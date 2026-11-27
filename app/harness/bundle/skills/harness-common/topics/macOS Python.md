# macOS Python

Facts about `/usr/bin/python3` on macOS, the only Python the harness scripts use. Checked on 2026-11-25 on the maintainer's Mac with scripted runs in `mktemp -d` folders. Docs: [Python 3.9 command line](https://docs.python.org/3.9/using/cmdline.html), [unittest](https://docs.python.org/3.9/library/unittest.html).

Used by: `install.py` and every `skills/*/scripts/*.py` (shebang `#!/usr/bin/python3`, run as `/usr/bin/python3 -I`).

## The interpreter

| Fact | Source |
|---|---|
| `/usr/bin/python3` is a shim for the Command Line Tools Python, 3.9.6, under `/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9`. | Scripted check (`sys.version`, `sys.prefix`, `xcode-select -p`) |
| A fresh Mac gets it with the Command Line Tools (`xcode-select --install`, or the prompt the first `git` call shows). | `README.md` "Install" |
| asdf, pyenv and Homebrew Python do not change what `/usr/bin/python3` runs. | Absolute path; `README.md` "Install" |
| Scripts use the standard library only, and no syntax newer than 3.9. | NFR-01; `install.py:1`, `#!/usr/bin/python3` in every script |
| In 3.9, `unittest` counts an unexpected success of an `expectedFailure` test as a failure: the run is not successful. | unittest docs, `TestResult.wasSuccessful` |

## `-I` (isolated mode)

| Fact | Source |
|---|---|
| `-I` ignores `PYTHON*` environment variables and the user site folder. `sys.flags.isolated`, `ignore_environment` and `no_user_site` are all 1. | Python docs, `-I`; scripted check |
| `-I` leaves the script's folder out of `sys.path`: `sys.path[0]` is `python39.zip`, and a module next to the script does not import. | Scripted check |

### Quirk: a script cannot import its neighbours

- Symptom: `import <sibling>` fails with `ModuleNotFoundError` when the script runs as `/usr/bin/python3 -I script.py`.
- Cause: `-I` drops the script's folder from `sys.path`.
- Workaround: one bootstrap line before the import, `sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harness-common" / "scripts"))`. `resolve()` follows the skill symlink into the checkout.
- Code: `install.py:15`, which sits at the repo root and inserts `skills/harness-common/scripts` instead. Every skill script that imports shared code adds the line above.

## Bytecode files

| Fact | Source |
|---|---|
| With `-I`, this Python writes no `.pyc` on import: `sys.flags.dont_write_bytecode` is 1, with or without `PYTHONDONTWRITEBYTECODE`. Cause unknown (Apple's build). | Scripted check, clean environment (`env -i`) |
| Without `-I`, it writes bytecode under `~/Library/Caches/com.apple.python` (`sys.pycache_prefix`), not next to the source. | Scripted check |
| `python3 -m py_compile <file>` always writes `__pycache__/<name>.cpython-39.pyc` next to the file, even with `-I` and `PYTHONDONTWRITEBYTECODE=1`. | Scripted check |

### Quirk: the parse check leaves `__pycache__/` in the tree

- Symptom: `__pycache__/` folders appear next to `install.py` and in `skills/*/scripts/`, and show as untracked files.
- Cause: `py_compile` writes bytecode on purpose; the environment variable and `-I` do not stop it.
- Workaround: parse without writing, `/usr/bin/python3 -I -c 'import sys; [compile(open(f).read(), f, "exec") for f in sys.argv[1:]]' install.py skills/*/scripts/*.py`. `.gitignore` lists `__pycache__/` and `*.pyc`, so a stray cache never shows as untracked.
- Code: the parse check in `skills/rearchitect/SKILL.md` Stage 0 (`compile()`, not `py_compile`); `.gitignore`.
