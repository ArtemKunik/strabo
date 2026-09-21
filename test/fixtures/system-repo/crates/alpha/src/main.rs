mod db;
mod routes;
mod service;

use crate::routes::routes;
use crate::service::service;

fn main() {
    let _ = routes();
    let _ = service();
}
