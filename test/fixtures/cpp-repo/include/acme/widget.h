#pragma once
#include <string>
#include "acme/base.h"

namespace acme {

class Widget : public Base {
public:
  explicit Widget(int limit);
  void render();
  int count() const { return count_; }

private:
  int count_ = 0;
  std::string name_;
};

}  // namespace acme
