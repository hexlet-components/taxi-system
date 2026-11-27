required_version = 6
for visible_version in (5, 6, 7):
    print("ждать" if visible_version < required_version else "готово")
