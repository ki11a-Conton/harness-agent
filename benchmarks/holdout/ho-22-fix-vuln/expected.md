run('x; rm -rf /') never executes the injected part — it runs the command with a literal argument.
