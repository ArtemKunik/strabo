#include "acme/widget.h"
#include "util/log.h"
#include <vector>

namespace acme {

Widget::Widget(int limit) { count_ = limit; }

void Widget::render() {
  for (int i = 0; i < count_; ++i) {
    if (i % 2 == 0 && count_ > 1) {
      log_line(name_);
    }
  }
  this->render_tail();
}

void Widget::render_tail() { count_ = 0; }

}  // namespace acme
