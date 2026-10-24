import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;

import java.time.Duration;
import java.util.List;
import java.util.Properties;

public class TripConsumer {
    public static void main(String[] args) {
        for (String group : List.of("lesson-java-report", "lesson-java-rebuild")) {
            var settings = new Properties();
            settings.setProperty(
                    "bootstrap.servers",
                    System.getenv().getOrDefault("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092"));
            settings.setProperty("group.id", group);
            settings.setProperty("key.deserializer", StringDeserializer.class.getName());
            settings.setProperty("value.deserializer", StringDeserializer.class.getName());

            // У новой группы нет позиции, поэтому читаем доступную историю
            settings.setProperty("auto.offset.reset", "earliest");
            settings.setProperty("enable.auto.commit", "false");

            try (var consumer = new KafkaConsumer<String, String>(settings)) {
                consumer.subscribe(List.of("lesson-java-trips"));
                int received = 0;
                long deadline = System.nanoTime() + Duration.ofSeconds(30).toNanos();

                // Ограничиваем учебный запуск двумя записями и временем ожидания
                while (received < 2 && System.nanoTime() < deadline) {
                    var records = consumer.poll(Duration.ofSeconds(1));
                    for (var record : records) {
                        System.out.println(group + ": " + record.value());
                        received++;
                    }
                }
                if (received != 2) {
                    throw new IllegalStateException("Expected two events for " + group);
                }
            }
        }
    }
}
