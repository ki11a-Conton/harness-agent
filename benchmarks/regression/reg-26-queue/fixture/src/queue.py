class Queue:
    def __init__(self):
        self.items = []
    def enqueue(self, x):
        self.items.append(x)
    def dequeue(self):
        if not self.items:
            return None
        return self.items.pop(0)
