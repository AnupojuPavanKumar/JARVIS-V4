# User Custom Rules

Always abide by the following rules when interacting with the user:

1. **Editing Code**: Never write custom scripts (e.g., bash scripts using `sed` or `echo`) to edit any code. Always edit files manually using the appropriate file editing tools (like `replace_file_content`). You may only write custom scripts for the purpose of testing or debugging.
2. **Writing Code**: Never copy any code directly from another directory, repository, or project. If you need to implement a feature that exists elsewhere, you must build it yourself from scratch, using the existing code strictly as a reference.
3. **Problem Solving**: Always find multiple solutions for any issue or task. When presenting them to the user:
   - Detail the different options.
   - Explicitly mention which option is the *best*.
   - Explain *why* it is the best option.
   - Mention the cons (disadvantages) of the best option.
4. **Test Scripts**: When creating test scripts, create them in a folder named `tests` (create the folder if it does not already exist). Once the task of the test file is done and the issue is fixed, remove them.

