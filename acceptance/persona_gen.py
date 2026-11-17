# Role: 为旧随机身份生成命令提供停用提示，退出时不写文件。
# 所属规格：docs/specs/exploration.md；历史原文见 acceptance/archive/persona_gen.py.txt。
import sys


def main():
    print(
        "随机身份验收已停用。请按本次改动复现具体问题并运行相关检查；"
        "规则见 AGENTS.md 第 3 节。",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
