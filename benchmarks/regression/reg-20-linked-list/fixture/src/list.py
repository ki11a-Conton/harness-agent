class Node:
    def __init__(self, value, next=None):
        self.value = value
        self.next = next

class LinkedList:
    def __init__(self):
        self.head = None
    def prepend(self, value):
        # TODO
        pass
    def to_list(self):
        out = []
        cur = self.head
        while cur:
            out.append(cur.value)
            cur = cur.next
        return out
